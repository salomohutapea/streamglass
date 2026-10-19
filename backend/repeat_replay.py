"""Owned, sequential replay jobs; cancellation affects only the job's own flow."""
import asyncio
import time
import uuid

from aiohttp import web
from .lab import replay_message, replay_flow


def validate(value):
    if not isinstance(value, dict) or set(value) != {"request", "count", "intervalMs", "timeoutMs", "stopOnError", "confirmSend"}:
        raise ValueError("Expected request, count, intervalMs, timeoutMs, stopOnError, and confirmSend")
    for key, low, high in (("count", 1, 100), ("intervalMs", 0, 60000), ("timeoutMs", 1000, 60000)):
        if type(value[key]) is not int or not low <= value[key] <= high:
            raise ValueError(f"{key} must be {low}..{high}")
    if value["confirmSend"] is not True or type(value["stopOnError"]) is not bool:
        raise ValueError("Repeated sending requires explicit confirmation")
    return replay_message(value["request"])


def public(job):
    return {key: value for key, value in job.items() if key not in ("task", "handler", "flow")}


async def stop_jobs(service, reason="Proxy stopped; repeated replay cancelled"):
    jobs = [job for job in getattr(service, "replay_jobs", {}).values() if job["state"] == "running"]
    for job in jobs:
        job.update(state="cancelled", error=reason)
        job["task"].cancel()
    if jobs:
        await asyncio.gather(*(job["task"] for job in jobs), return_exceptions=True)
        for job in jobs:
            job["endedAt"] = time.time()


async def run_job(service, job, message):
    from mitmproxy.addons.clientplayback import ReplayHandler
    try:
        for index in range(job["count"]):
            if service.master is None or not service.settings["proxyEnabled"]:
                raise ValueError("Proxy stopped; no further requests were sent")
            if index:
                await asyncio.sleep(job["intervalMs"] / 1000)
            if service.master is None:
                raise ValueError("Proxy stopped; no further requests were sent")
            flow = replay_flow(service, message.copy())
            flow.is_replay = "request"
            flow.metadata["streamglass_repeat_job"] = job["id"]
            job["flow"] = flow
            handler = ReplayHandler(flow, service.master.options)
            job["handler"] = handler
            started = time.time()
            issue = None
            try:
                await asyncio.wait_for(handler.replay(), job["timeoutMs"] / 1000)
                issue = str(flow.error) if flow.error else None
            except TimeoutError:
                issue = "Replay timed out"
                if flow.killable:
                    flow.kill()
                service.cancel(flow.id, issue)
            finally:
                tasks = [entry.handler for entry in handler.transports.values() if entry.handler]
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                job["handler"] = None
            code = flow.response.status_code if flow.response else None
            job["results"].append({"iteration": index + 1, "recordId": flow.id, "statusCode": code,
                                   "durationMs": round((time.time() - started) * 1000), "error": issue,
                                   "eventCount": service.records.get(flow.id, {}).get("eventCount", 0)})
            job["flow"] = None
            if job["stopOnError"] and (issue or code is not None and code >= 400):
                job.update(state="stopped", error=issue or f"HTTP {code}")
                break
        else:
            job["state"] = "complete"
    except asyncio.CancelledError:
        flow = job.get("flow")
        if flow is not None:
            if flow.killable:
                flow.kill()
            service.cancel(flow.id, "Repeated replay cancelled")
        job["state"] = "cancelled"
    except Exception as exc:
        flow = job.get("flow")
        if flow is not None:
            if flow.killable:
                flow.kill()
            service.cancel(flow.id, "Repeated replay failed")
        job.update(state="error", error=str(exc)[:1024])
    finally:
        job.update(endedAt=time.time(), flow=None, handler=None)


def install(app, service):
    service.replay_jobs = {}

    async def jobs(request):
        if request.method == "POST":
            if service.master is None:
                raise ValueError("Start the proxy before sending repeated requests")
            value = await request.json()
            message = validate(value)
            if any(job["state"] == "running" for job in service.replay_jobs.values()):
                raise web.HTTPConflict(reason="A repeated replay is already running. Cancel it or wait for completion.")
            for job_id in list(service.replay_jobs)[:-19]:
                service.replay_jobs.pop(job_id)
            job = {"id": str(uuid.uuid4()), "state": "running", "startedAt": time.time(), "endedAt": None,
                   "url": message.url, "method": message.method, "count": value["count"], "intervalMs": value["intervalMs"],
                   "timeoutMs": value["timeoutMs"], "stopOnError": value["stopOnError"], "results": [], "error": None}
            service.replay_jobs[job["id"]] = job
            job["task"] = asyncio.create_task(run_job(service, job, message))
            return web.json_response(public(job), status=202)
        return web.json_response({"jobs": [public(job) for job in reversed(list(service.replay_jobs.values()))]})

    async def cancel(request):
        job = service.replay_jobs.get(request.match_info["job"])
        if job is None:
            raise web.HTTPNotFound()
        if job["state"] == "running":
            job["state"] = "cancelled"
            job["task"].cancel()
            await asyncio.gather(job["task"], return_exceptions=True)
            job["endedAt"] = time.time()
        return web.json_response(public(job))

    app.add_routes([web.get("/api/replay-jobs", jobs), web.post("/api/replay-jobs", jobs),
                    web.post("/api/replay-jobs/{job}/cancel", cancel)])

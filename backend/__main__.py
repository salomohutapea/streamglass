import argparse
import asyncio
import json
import os
import signal

from aiohttp import web, ClientSession, ClientTimeout

from .api import create_app
from .engine import patch_engine
from .service import Service


async def run(args):
    import logging
    logging.basicConfig(level=logging.ERROR)
    service = Service(args.data_dir, args.token, args.port)
    service.discard_captures()  # captures never outlive a session; this also clears leftovers from a crash
    patch_engine(service.cancel)
    service.http = ClientSession(timeout=ClientTimeout(total=10))
    runner = web.AppRunner(create_app(service), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", args.port).start()
    await service.start_proxy()
    broadcaster = asyncio.create_task(service.broadcast())
    icon_refresh = asyncio.create_task(service.refresh_application_icons())
    from .productivity import monitor
    assertion_monitor = asyncio.create_task(monitor(service))
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    print(json.dumps({"type": "ready", "port": args.port}), flush=True)
    try:
        stop_task = asyncio.create_task(stopped.wait())
        await stop_task
    finally:
        replay_tasks = [job["task"] for job in service.replay_jobs.values() if not job["task"].done()]
        for task in replay_tasks:
            task.cancel()
        await asyncio.gather(*replay_tasks, return_exceptions=True)
        for flow_id in list(service.flows):
            service.cancel(flow_id, "Proxy shutting down")
        if service.master:
            service.master.shutdown()
            await service.proxy_task
        broadcaster.cancel()
        icon_refresh.cancel()
        assertion_monitor.cancel()
        await asyncio.gather(icon_refresh, assertion_monitor, return_exceptions=True)
        await service.http.close()
        await runner.cleanup()
        try:
            service.discard_captures()  # after every flow has stopped writing
        except Exception:
            pass
        service.db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=47821)
    parser.add_argument("--token", default=os.environ.get("STREAMGLASS_TOKEN", ""))
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    if len(args.token) < 24:
        parser.error("token must have at least 24 characters")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()

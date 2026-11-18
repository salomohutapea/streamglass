#!/usr/bin/env python3
"""Benchmark the Streamglass engine against a synthetic loopback origin."""

import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager

from aiohttp import ClientSession, ClientTimeout, TCPConnector, web


HOST = "127.0.0.1"
ITEM = json.dumps({"needle": "perf-needle", "items": ["x" * 60] * 20}).encode()
CONNECT_TIMEOUT = 15
# Seed after the normal startup load, which reads at most 1,000 database rows.
# The certificate override applies only to this subprocess and still verifies the origin.
LAUNCHER = """
import cProfile, os, runpy, sys
from backend.__main__ import main
from backend.service import Service
seed_records = runpy.run_path(sys.argv.pop(1))["seed_records"]

profile = cProfile.Profile() if os.environ.get("PERF_CPROFILE") else None
start_proxy = Service.start_proxy
async def prepare(self):
    await start_proxy(self)
    if path := os.environ.get("PERF_ORIGIN_CA"):
        self.master.options.update(ssl_verify_upstream_trusted_ca=path)
    count = int(os.environ["PERF_SEED"])
    if count:
        seed_records(self, count)
    if profile:
        profile.enable()

Service.start_proxy = prepare
try:
    main()
finally:
    if profile:
        profile.disable()
        profile.dump_stats(os.environ["PERF_CPROFILE"])
"""


def seed_records(service, count):
    events = [{"sequence": n + 1, "event": "message", "data": '{"token":"perf"}', "raw": 'data: {"token":"perf"}\n\n'}
              for n in range(200)]
    for index in range(count):
        id_ = f"seed-{index}"
        url = f"https://fixture.test/items/{index}"
        sse = index == 0
        service.save({
            "id": id_, "kind": "request", "url": url, "startedAt": index + 1,
            "endedAt": index + 1.2, "durationMs": 200, "method": "GET",
            "state": "complete", "statusCode": 200, "device": HOST,
            "sslInspected": count > 1000, "isSSE": sse, "eventCount": len(events) if sse else 0,
            "events": events if sse else [],
            "request": {"url": url, "headers": [["Accept", "application/json"]]},
            "response": {"headers": [["Content-Type", "text/event-stream" if sse else "application/json"]],
                         "body": "" if sse else ITEM.decode()},
        })


def free_port():
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def stats(values):
    ordered = sorted(values)
    return {"count": len(ordered), **{
        f"p{p}Ms": round(ordered[math.ceil(len(ordered) * p / 100) - 1] * 1000, 3)
        for p in (50, 95, 99)
    }}


def process_stats(pid):
    output = subprocess.check_output(["ps", "-o", "time=,rss=", "-p", str(pid)], text=True)
    elapsed, rss = output.split()
    cpu_seconds = 0
    for part in elapsed.split(":"):
        cpu_seconds = cpu_seconds * 60 + float(part)
    return cpu_seconds, int(rss) / 1024


async def measured(pid, run):
    load = os.getloadavg()
    cpu, rss = process_stats(pid)
    peak = rss

    async def sample_rss():
        nonlocal peak
        while True:
            await asyncio.sleep(.05)
            peak = max(peak, process_stats(pid)[1])

    sampler = asyncio.create_task(sample_rss())
    start = time.perf_counter()
    try:
        result = await run()
    finally:
        sampler.cancel()
        await asyncio.gather(sampler, return_exceptions=True)
    duration = time.perf_counter() - start
    end_cpu, end_rss = process_stats(pid)
    return {**result, "wallSeconds": round(duration, 3), "cpuPercent": round((end_cpu - cpu) / duration * 100, 2),
            "rssBeforeMiB": round(rss, 2), "rssPeakMiB": round(max(peak, end_rss), 2),
            "rssAfterMiB": round(end_rss, 2), "loadBefore": load, "loadAfter": os.getloadavg()}


async def origin(request):
    if request.path == "/sse":
        count = int(request.query["count"])
        result = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await result.prepare(request)
        start = time.monotonic()
        for n in range(count):
            await asyncio.sleep(max(0, start + n / 50 - time.monotonic()))
            event = json.dumps({"n": n, "sent": time.monotonic(), "pad": "x" * 260})
            await result.write(f"data: {event}\n\n".encode())
        return result
    if request.path.startswith("/body/"):
        size = int(request.match_info["size"])
        data = BODY[:size]
        if request.query.get("chunked") != "1":
            return web.Response(body=data, content_type="application/octet-stream")
        result = web.StreamResponse(headers={"Content-Type": "application/octet-stream"})
        await result.prepare(request)
        for offset in range(0, size, 65536):
            await result.write(data[offset:offset + 65536])
        return result
    return web.Response(body=ITEM, content_type="application/json")


def tls_origin(directory):
    # A short-lived test certificate for a single local hostname. Never touch the OS trust store.
    cert, key = directory / "upstream.pem", directory / "upstream-key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
                    "-out", str(cert), "-keyout", str(key)], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return cert, context


@asynccontextmanager
async def engines(args, label, seed=0, origin_ca=None, paused=False):
    with tempfile.TemporaryDirectory(dir=args.out, prefix="profile-") as tmp:
        path = Path(tmp)
        port = free_port()
        proxy_port = free_port()
        while proxy_port == port:
            proxy_port = free_port()
        token = secrets.token_hex(24)
        env = {k: v for k, v in os.environ.items() if not k.startswith("STREAMGLASS_") and k != "PYTHONPATH"}
        env.update(STREAMGLASS_DATA_DIR=tmp, STREAMGLASS_TOKEN=token, STREAMGLASS_PROXY_PORT=str(proxy_port),
                   PERF_SEED=str(seed), PYTHONDONTWRITEBYTECODE="1")
        if origin_ca:
            env["PERF_ORIGIN_CA"] = str(origin_ca)
            import sqlite3
            with sqlite3.connect(path / "captures.sqlite3") as db:
                db.execute("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                db.execute("INSERT INTO config VALUES ('settings', ?)", (json.dumps({"tlsDomains": ["localhost"]}),))
        if args.profile == "cprofile":
            env["PERF_CPROFILE"] = str(args.out / f"{label}.pstats")
        command = [sys.executable, "-m", "backend"]
        if seed or origin_ca or args.profile == "cprofile":
            command = [sys.executable, "-c", LAUNCHER, str(Path(__file__).resolve())]
        command.extend(["--port", str(port), "--data-dir", tmp])
        start = time.perf_counter()
        with (args.out / f"{label}.engine.log").open("wb") as log:
            child = await asyncio.create_subprocess_exec(*command, cwd=args.engine_root, env=env,
                                                        stdout=asyncio.subprocess.PIPE, stderr=log)
            try:
                ready = await asyncio.wait_for(child.stdout.readline(), CONNECT_TIMEOUT)
                boot_ms = round((time.perf_counter() - start) * 1000, 3)
                if not ready or json.loads(ready)["type"] != "ready":
                    raise RuntimeError(f"Engine failed to start. See {label}.engine.log")
                async with ClientSession(base_url=f"http://{HOST}:{port}",
                                         headers={"Authorization": f"Bearer {token}"},
                                         timeout=ClientTimeout(total=CONNECT_TIMEOUT)) as api:
                    async with api.get("/api/state") as response:
                        response.raise_for_status()
                        state = await response.json()
                    if not state["settings"]["proxyRunning"] or len(state["records"]) != seed:
                        raise RuntimeError("Proxy did not start or history did not match the fixture")
                    if paused:
                        async with api.put("/api/settings", json={"capturePaused": True}) as response:
                            response.raise_for_status()
                    yield child.pid, f"http://{HOST}:{proxy_port}", api, path, boot_ms
            finally:
                if child.returncode is None:
                    child.terminate()
                    try:
                        await asyncio.wait_for(child.wait(), 10)
                    except TimeoutError:
                        child.kill()
                        await child.wait()
                if child.returncode:
                    raise RuntimeError(f"Engine exited {child.returncode}. See {label}.engine.log")


@asynccontextmanager
async def sampling(args, pid, label):
    if args.profile != "py-spy":
        yield
        return
    binary = Path(sys.executable).parent / "py-spy"
    with (args.out / f"{label}.py-spy.log").open("wb") as log:
        spy = await asyncio.create_subprocess_exec(str(binary), "record", "--pid", str(pid),
            "--output", str(args.out / f"{label}.svg"), stderr=log, stdout=log)
        try:
            yield
        finally:
            if spy.returncode is None:
                spy.send_signal(2)  # SIGINT lets py-spy write the graph.
            await asyncio.wait_for(spy.wait(), 10)


async def item(client, target, proxy, context=None):
    start = time.perf_counter()
    async with client.get(target + "/items", proxy=proxy, ssl=context if context else True) as response:
        response.raise_for_status()
        if await response.read() != ITEM:
            raise RuntimeError("Incorrect item bytes")
    return time.perf_counter() - start


async def paced(duration, rate, operation):
    start = time.monotonic()
    tasks = []
    for index in range(round(duration * rate)):
        await asyncio.sleep(max(0, start + index / rate - time.monotonic()))
        tasks.append(asyncio.create_task(operation()))
    return await asyncio.gather(*tasks)


async def saturated(seconds, workers, operation):
    stop = time.monotonic() + seconds

    async def worker():
        values = []
        while time.monotonic() < stop:
            values.append(await operation())
        return values

    values = [sample for value in await asyncio.gather(*(worker() for _ in range(workers))) for sample in value]
    return {**stats(values), "requestsPerSecond": round(len(values) / (time.monotonic() - stop + seconds), 2)}


async def sse(client, target, proxy, count):
    values = []
    async with client.get(f"{target}/sse?count={count}", proxy=proxy) as response:
        response.raise_for_status()
        async for line in response.content:
            if line.startswith(b"data: "):
                event = json.loads(line[6:])
                if event["n"] != len(values) or event["pad"] != "x" * 260:
                    raise RuntimeError("Incorrect SSE sequence or data")
                values.append(time.monotonic() - event["sent"])
    if len(values) != count:
        raise RuntimeError(f"Received {len(values)} of {count} events")
    return values


async def body(client, target, proxy, size, chunked):
    start = time.perf_counter()
    async with client.get(f"{target}/body/{size}?chunked={int(chunked)}", proxy=proxy) as response:
        response.raise_for_status()
        digest = hashlib.sha256()
        async for chunk in response.content.iter_chunked(65536):
            digest.update(chunk)
    elapsed = time.perf_counter() - start
    if digest.digest() != hashlib.sha256(BODY[:size]).digest():
        raise RuntimeError("Incorrect large body bytes")
    return elapsed


async def management(api, duration, seed):
    async with api.get("/api/state") as response:
        response.raise_for_status()
        state = await response.json()
        snapshot_bytes = len(await response.read())
    since = f"{state['instance']}:{state['revision']}"

    async def get(path, params=None):
        start = time.perf_counter()
        async with api.get(path, params=params) as response:
            response.raise_for_status()
            data = await response.read()
        return time.perf_counter() - start, data

    async def state_poll():
        nonlocal since
        elapsed, data = await get("/api/state", {"since": since})
        value = json.loads(data)
        since = f"{value['instance']}:{value['revision']}"
        if not value["delta"] or len(value["ids"]) < seed:
            raise RuntimeError("Missing state diff/history")
        return elapsed, data

    async def samples(rate, operation):
        values = await paced(duration, rate, operation)
        return {**stats([elapsed for elapsed, _ in values]),
                "meanBytes": round(sum(len(data) for _, data in values) / len(values))}

    return {"snapshotBytes": snapshot_bytes, **dict(zip(("state", "search", "record"), await asyncio.gather(
        samples(10, state_poll),
        samples(4, lambda: get("/api/search", {"scope": "response", "q": "perf-needle"})),
        samples(4, lambda: get("/api/records/seed-0" if seed > 1000 else "/api/records/seed-999")),
    )))}


async def suite(args, target, tls_target, origin_ca):
    async with ClientSession(connector=TCPConnector(limit=64), timeout=ClientTimeout(total=CONNECT_TIMEOUT)) as client:
        results = {}
        for name in args.scenarios:
            seed = int(name[3:]) if name.startswith("api") else 0
            use_tls = name == "https"
            async with engines(args, name, seed, origin_ca if use_tls else None, paused=name == "paused") as (pid, proxy, api, path, boot):
                if name == "cold":
                    results[name] = {"readyMs": boot, "load": os.getloadavg(), "rssMiB": process_stats(pid)[1]}
                    (args.out / "results.json").write_text(json.dumps(results, indent=2) + "\n")
                    continue
                url = tls_target if use_tls else target
                proxy_context = ssl.create_default_context(cafile=path / "mitmproxy" / "mitmproxy-ca-cert.pem") if use_tls else None
                direct_context = ssl.create_default_context(cafile=origin_ca) if use_tls else None
                await item(client, url, proxy, proxy_context)
                if name in ("http", "paused", "https"):
                    direct = await paced(args.seconds, 20, lambda: item(client, url, None, direct_context))
                    async with sampling(args, pid, name):
                        result = await measured(pid, lambda: summarize(paced(args.seconds, 20, lambda: item(client, url, proxy, proxy_context))))
                    if use_tls:
                        async with api.get("/api/state") as response:
                            if not any(row["sslInspected"] and row["statusCode"] == 200 for row in (await response.json())["records"]):
                                raise RuntimeError("HTTPS was not inspected")
                    results[name] = {**result, "direct": stats(direct)}
                elif name == "ramp":
                    async with sampling(args, pid, name):
                        results[name] = {workers: await measured(pid, lambda: saturated(args.seconds, workers,
                            lambda: item(client, url, proxy))) for workers in (1, 8, 32)}
                elif name == "sse":
                    async def streams(via):
                        samples = await asyncio.gather(*(sse(client, target, via, round(args.seconds * 50)) for _ in range(args.streams)))
                        return stats([value for stream in samples for value in stream])

                    direct = await streams(None)
                    async with sampling(args, pid, name):
                        results[name] = {**await measured(pid, lambda: streams(proxy)), "direct": direct}
                elif name == "bodies":
                    for size, chunked in ((1024**2, False), (10 * 1024**2, False), (10 * 1024**2, True)):
                        async def download(via):
                            return stats([await body(client, target, via, size, chunked) for _ in range(6)])

                        direct = await download(None)
                        results.setdefault(name, {})[f"{size}-{int(chunked)}"] = {
                            **await measured(pid, lambda: download(proxy)), "direct": direct}
                else:
                    async def mixed():
                        traffic, endpoints = await asyncio.gather(
                            summarize(paced(args.seconds, 20, lambda: item(client, url, proxy))),
                            management(api, args.seconds, seed))
                        return {"traffic": traffic, **endpoints}

                    async with sampling(args, pid, name):
                        results[name] = await measured(pid, mixed)
                print(name, json.dumps(results[name]), flush=True)
                (args.out / "results.json").write_text(json.dumps(results, indent=2) + "\n")


async def summarize(values):
    return stats(await values)


async def run(args):
    app = web.Application()
    app.router.add_get("/body/{size}", origin)
    app.router.add_get("/{path:.*}", origin)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        with tempfile.TemporaryDirectory(dir=args.out, prefix="upstream-") as tmp:
            ca, context = tls_origin(Path(tmp)) if "https" in args.scenarios else (None, None)
            http_port, https_port = free_port(), free_port()
            await web.TCPSite(runner, HOST, http_port).start()
            if context:
                await web.TCPSite(runner, HOST, https_port, ssl_context=context).start()
            await suite(args, f"http://{HOST}:{http_port}", f"https://localhost:{https_port}", ca)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    BODY = b"0123456789abcdef" * (10 * 1024 * 1024 // 16)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="New directory in which to store synthetic results")
    parser.add_argument("--engine-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--streams", type=int, default=16)
    parser.add_argument("--profile", choices=("py-spy", "cprofile"))
    scenarios = ["cold", "http", "paused", "ramp", "bodies", "sse", "https", "api1000", "api5000"]
    parser.add_argument("scenarios", nargs="*", metavar="SCENARIO", help=", ".join(scenarios))
    args = parser.parse_args()
    if set(args.scenarios) - set(scenarios) or args.seconds <= 0 or not 1 <= args.streams <= 64:
        parser.error("Use a listed scenario, positive --seconds, and --streams between 1 and 64")
    args.scenarios = args.scenarios or scenarios
    args.out = args.out.resolve()
    args.engine_root = args.engine_root.resolve()
    args.out.mkdir(parents=True)
    asyncio.run(run(args))

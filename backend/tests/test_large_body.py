"""Large REST wire fidelity on temporary loopback listeners; no trust changes."""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp import ClientSession, ClientTimeout, web

from mitmproxy import http

from backend.large_body import MAX_PREVIEW, apply_streamed_headers, before_responseheaders
from backend.service import Service
from backend.tests.test_integration import free_port


class LargeBodyIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="streamglass-large-rest-")
        self.api_port, self.proxy_port = free_port(), free_port()
        self.token = "large-rest-integration-token-123456"
        service = Service(self.directory.name, self.token, self.api_port)
        service.settings["proxyPort"] = self.proxy_port
        service.persist_config()
        service.db.close()
        self.chunk = bytes(range(256)) * 256
        self.count = 512
        self.expected_hash = hashlib.sha256(self.chunk * self.count).hexdigest()
        self.origin_continue = asyncio.Event()
        self.origin_continue.set()

        async def large(request):
            headers = {"Content-Type": "application/octet-stream"}
            if request.match_info["framing"] == "length":
                headers["Content-Length"] = str(len(self.chunk) * self.count)
            response = web.StreamResponse(headers=headers)
            await response.prepare(request)
            if not request.query.get("late"):
                await self.origin_continue.wait()
            for index in range(self.count):
                await response.write(self.chunk)
                if request.query.get("late") and index == 128:
                    await self.origin_continue.wait()
            await response.write_eof()
            return response

        app = web.Application()
        app.router.add_get("/large/{framing}", large)
        async def opaque(request):
            response = web.StreamResponse(headers={"Content-Type": "text/plain;charset=UTF-8"})
            await response.prepare(request)
            await response.write(b"encrypted+/opaque=payload")
            return response
        app.router.add_post("/flight/search/initial", opaque)
        self.origin = web.AppRunner(app)
        await self.origin.setup()
        site = web.TCPSite(self.origin, "127.0.0.1", 0)
        await site.start()
        self.url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        self.log = open(Path(self.directory.name, "engine.log"), "wb")
        executable = os.environ.get("STREAMGLASS_TEST_ENGINE")
        command = [executable] if executable else [sys.executable, "-m", "backend"]
        self.process = await asyncio.create_subprocess_exec(
            *command, "--port", str(self.api_port), "--token", self.token,
            "--data-dir", self.directory.name, stdout=asyncio.subprocess.PIPE, stderr=self.log)
        try:
            ready = await asyncio.wait_for(self.process.stdout.readline(), 20)
            self.assertEqual(json.loads(ready)["type"], "ready")
        except Exception:
            self.process.terminate()
            await self.process.wait()
            self.log.close()
            raise AssertionError(Path(self.directory.name, "engine.log").read_text())
        self.client = ClientSession(timeout=ClientTimeout(total=30))
        self.api = f"http://127.0.0.1:{self.api_port}/api"
        self.proxy = f"http://127.0.0.1:{self.proxy_port}"
        self.auth = {"Authorization": "Bearer " + self.token}

    async def asyncTearDown(self):
        await self.client.close()
        self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 10)
        self.log.close()
        await self.origin.cleanup()
        self.directory.cleanup()

    async def rules_revision(self):
        async with self.client.get(self.api + "/state", headers=self.auth) as response:
            self.assertEqual(response.status, 200)
            return (await response.json())["rulesRevision"]

    async def check_large_response(self, framing):
        digest, received = hashlib.sha256(), 0
        async with self.client.get(self.url + "/large/" + framing, proxy=self.proxy) as response:
            self.assertEqual(response.status, 200)
            async for chunk in response.content.iter_chunked(65536):
                digest.update(chunk)
                received += len(chunk)
        self.assertEqual(received, 32 * 1024 * 1024)
        self.assertEqual(digest.hexdigest(), self.expected_hash)
        record = None
        for _ in range(100):
            async with self.client.get(self.api + "/state", headers=self.auth) as response:
                rows = (await response.json())["records"]
            if rows and rows[0]["state"] == "complete":
                async with self.client.get(self.api + "/records/" + rows[0]["id"], headers=self.auth) as response:
                    record = await response.json()
                break
            await asyncio.sleep(.03)
        self.assertIsNotNone(record)
        self.assertTrue(record["captureWarning"])
        capture = record["response"]
        self.assertTrue(capture["bodyUnavailable"])
        self.assertEqual(capture["bodyBytes"], received)
        self.assertEqual(capture["bodyPreviewBytes"], MAX_PREVIEW)
        self.assertEqual(capture["body"], "")
        self.assertEqual(capture["bodyBase64"], "")
        self.assertLess(len(json.dumps(record)), 1024 * 1024)
        async with self.client.get(self.api + "/export/" + record["id"] + "?format=response", headers=self.auth) as response:
            self.assertEqual(response.status, 400)
            self.assertIn("Full body export is unavailable", str(await response.json()))

    async def test_content_length_32m_rest_passthrough(self):
        await self.check_large_response("length")

    async def test_chunked_32m_rest_passthrough(self):
        await self.check_large_response("chunked")

    async def test_chunked_opaque_rest_breakpoint_has_editable_body(self):
        rule = {"id": "opaque", "pattern": "*/flight/search/initial", "stages": ["response"], "breakpoint": True}
        async with self.client.put(self.api + "/rules", headers=self.auth, json={"revision": await self.rules_revision(), "rules": [rule]}) as response:
            self.assertEqual(response.status, 200)
        incoming = asyncio.create_task(self.client.post(self.url + "/flight/search/initial", proxy=self.proxy))
        try:
            gate = None
            for _ in range(100):
                async with self.client.get(self.api + "/state", headers=self.auth) as response:
                    pending = (await response.json())["pending"]
                if pending:
                    gate = pending[0]
                    break
                await asyncio.sleep(.03)
            self.assertIsNotNone(gate)
            self.assertFalse(incoming.done(), "Response escaped before breakpoint resume")
            self.assertEqual(gate["value"]["body"], "encrypted+/opaque=payload")
            self.assertFalse(gate["value"].get("bodyUnavailable"))
            edited = {**gate["value"], "body": "edited opaque string"}
            async with self.client.post(self.api + "/pending/" + gate["token"], headers=self.auth,
                                        json={"action": "continue", "value": edited}) as response:
                self.assertEqual(response.status, 200)
            async with await incoming as response:
                self.assertEqual(await response.text(), "edited opaque string")
        finally:
            if not incoming.done():
                incoming.cancel()
            await asyncio.gather(incoming, return_exceptions=True)

    async def test_large_response_breakpoint_edits_headers_before_emission(self):
        await self.check_large_breakpoint("length")

    async def test_chunked_large_breakpoint_edits_headers_before_emission(self):
        await self.check_large_breakpoint("chunked?late=1")

    async def check_large_breakpoint(self, framing):
        rule = {"id": "headers", "pattern": "*/large/*", "stages": ["response"], "breakpoint": True}
        async with self.client.put(self.api + "/rules", headers=self.auth, json={"revision": await self.rules_revision(), "rules": [rule]}) as response:
            self.assertEqual(response.status, 200)
        self.origin_continue.clear()
        incoming = asyncio.create_task(self.client.get(self.url + "/large/" + framing, proxy=self.proxy))
        try:
            gate = None
            for _ in range(100):
                async with self.client.get(self.api + "/state", headers=self.auth) as response:
                    pending = (await response.json())["pending"]
                if pending:
                    gate = pending[0]
                    break
                await asyncio.sleep(.03)
            self.assertIsNotNone(gate)
            self.assertFalse(incoming.done(), "Response headers escaped before breakpoint resume")
            self.assertTrue(gate["value"]["bodyUnavailable"])
            endpoint = self.api + "/pending/" + gate["token"]
            edited = {**gate["value"], "body": "replacement"}
            async with self.client.post(endpoint, headers=self.auth, json={"action": "continue", "value": edited}) as response:
                self.assertEqual(response.status, 400)
                self.assertIn("Body editing is unavailable", str(await response.json()))
            self.assertFalse(incoming.done())
            edited = {**gate["value"], "statusCode": 202, "headers": [*gate["value"]["headers"], ["X-Edited", "yes"]]}
            async with self.client.post(endpoint, headers=self.auth, json={"action": "continue", "value": edited}) as response:
                self.assertEqual(response.status, 200)
            self.origin_continue.set()
            async with await incoming as response:
                self.assertEqual(response.status, 202)
                self.assertEqual(response.headers["X-Edited"], "yes")
                digest = hashlib.sha256()
                async for chunk in response.content.iter_chunked(65536):
                    digest.update(chunk)
                self.assertEqual(digest.hexdigest(), self.expected_hash)
        finally:
            self.origin_continue.set()
            if not incoming.done():
                incoming.cancel()
            await asyncio.gather(incoming, return_exceptions=True)


class LargeBodyRuleTests(unittest.IsolatedAsyncioTestCase):
    async def test_script_body_edit_is_explicitly_rejected(self):
        response = http.Response.make(200, b"", {"Content-Length": str(32 * 1024 * 1024)})
        response.headers["content-length"] = str(32 * 1024 * 1024)
        flow = SimpleNamespace(id="large", metadata={}, response=response, request=http.Request.make("GET", "http://example.test/large"))
        service = SimpleNamespace(records={}, process=AsyncMock(return_value={"body": "replacement"}))
        with self.assertRaisesRegex(ValueError, "body editing is unavailable"):
            await before_responseheaders(service, flow)

    async def test_no_content_status_drops_stream_and_framing(self):
        response = http.Response.make(200, b"body")
        response.headers["content-length"] = str(32 * 1024 * 1024)
        flow = SimpleNamespace(id="large", metadata={}, response=response, request=http.Request.make("GET", "http://example.test/large"))
        service = SimpleNamespace(records={}, process=AsyncMock(return_value={"statusCode": 204}))
        self.assertTrue(await before_responseheaders(service, flow))
        self.assertEqual(response.status_code, 204)
        self.assertNotIn("content-length", response.headers)
        self.assertNotIn("transfer-encoding", response.headers)
        self.assertEqual(response.stream(b"discarded body"), b"")

    async def test_stream_framing_edits_rejected_before_mutation(self):
        response = http.Response.make(200, b"original")
        for header in ("Content-Length", "Transfer-Encoding", "Content-Encoding"):
            with self.subTest(header=header):
                with self.assertRaisesRegex(ValueError, "Cannot edit"):
                    apply_streamed_headers(response, {"headers": [[header, "changed"]]})
                self.assertEqual(response.content, b"original")
                self.assertEqual(response.headers["content-length"], "8")

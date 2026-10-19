import asyncio
import copy
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from backend.api import create_app
from backend.service import Service
from backend.productivity import DEFAULT, select, validate, facts, assertions
from backend.repeat_replay import validate as validate_repeat, run_job


def capture(record_id="capture"):
    return {"id": record_id, "kind": "request", "url": "https://api.example.test/initial", "method": "POST", "device": "phone", "startedAt": 100.0,
            "endedAt": 101.0, "state": "complete", "eventCount": 0, "events": [],
            "request": {"url": "https://api.example.test/initial", "method": "POST", "headers": [], "body": '{"searchId":"search-1"}', "bodyBase64": ""},
            "response": {"statusCode": 200, "headers": [], "body": '{"context":{"searchId":"search-1"},"nullable":null}', "bodyBase64": ""}}


def rule(kind, **changes):
    return {"id": kind, "name": kind, "enabled": True, "pattern": "*", "method": "*", "kind": kind,
            "path": "$.context.searchId", "source": "response", "eventName": "data", "timeoutMs": 500, **changes}


class AnalysisTests(unittest.TestCase):
    def test_jsonpath_quoted_keys_wildcards_and_limits(self):
        self.assertEqual(select({"a.b": [{"*": 2}, {"*": 4}]}, '$["a.b"][*]["*"]'), [2, 4])
        self.assertEqual(select({"values": [0, 1]}, "$.values[0]"), [0])
        self.assertEqual(select({"missing": None}, "$.missing"), [None])
        for path in ("a.b", "$..secret", "$[?(@.enabled)]", "$.a[no]"):
            with self.assertRaises(ValueError):
                select({}, path)
        with self.assertRaises(ValueError):
            select(list(range(10001)), "$[*]")

    def test_watches_keep_large_integer_text_and_null(self):
        config = copy.deepcopy(DEFAULT)
        config["watches"] = [{"id": "id", "name": "ID", "source": "response", "path": "$.id"}, {"id": "null", "name": "Nullable", "source": "response", "path": "$.nullable"}]
        item = capture()
        item["response"]["body"] = '{"id":9007199254740993,"nullable":null}'
        value = facts(item, validate(config))
        self.assertEqual(value["watches"][0]["values"], ["9007199254740993"])
        self.assertEqual(value["watches"][1]["values"], ["null"])
        self.assertIn("search-1", value["correlations"])

    def test_deadline_duplicate_and_terminal_events(self):
        config = copy.deepcopy(DEFAULT)
        config["assertions"] = [rule("first-data"), rule("duplicate-event-id"), rule("terminal-event", eventName="done")]
        item = {**capture(), "isSSE": True, "state": "streaming", "sseDiagnostics": {"headersAt": 100}}
        value = facts(item, config)
        self.assertEqual(assertions(item, config, value, 100.2)[0]["result"], "pending")
        self.assertEqual(assertions(item, config, value, 100.6)[0]["result"], "fail")
        item.update(state="complete", eventCount=2, events=[{"sequence": 1, "event": "data", "id": "same", "receivedAt": 100.1, "processedAt": 100.8, "data": "{}"}, {"sequence": 2, "event": "done", "id": "same", "receivedAt": 100.9, "processedAt": 100.9, "data": "{}"}])
        results = assertions(item, config, facts(item, config), 101)
        self.assertEqual([result["result"] for result in results], ["fail", "fail", "pass"])

    def test_incomplete_retention_never_passes_missing_assertions(self):
        config = copy.deepcopy(DEFAULT)
        config["assertions"] = [rule("required-field"), rule("terminal-event")]
        item = {**capture(), "isSSE": True, "eventCount": 20}
        item["response"] = {"body": "", "bodyUnavailable": True}
        results = assertions(item, config, facts(item, config), 200)
        self.assertEqual([result["result"] for result in results], ["unknown", "unknown"])

    def test_configuration_rejects_invalid_paths_and_search_modes(self):
        config = copy.deepcopy(DEFAULT)
        config["watches"] = [{"id": "one", "name": "One", "source": "event", "path": "$..a"}]
        with self.assertRaises(ValueError):
            validate(config)
        config = copy.deepcopy(DEFAULT)
        config["journey"]["inventoryPath"] = None
        with self.assertRaises(ValueError):
            validate(config)

    def test_capture_warning_and_legacy_timing_are_unknown(self):
        config = copy.deepcopy(DEFAULT)
        config["assertions"] = [rule("first-data"), rule("duplicate-event-id"), rule("terminal-event", eventName="done")]
        item = {**capture(), "isSSE": True, "captureWarning": "Oversized SSE; later events were not parsed", "eventCount": 1,
                "events": [{"event": "data", "sequence": 1, "id": "one", "data": "{}", "receivedAt": 100.1}]}
        self.assertEqual([r["result"] for r in assertions(item, config, facts(item, config), 200)], ["unknown", "unknown", "unknown"])


class SessionApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "test-token", 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={"Authorization": "Bearer test-token", "Host": "127.0.0.1:47821"})
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def test_archive_is_immutable_reopenable_and_import_never_replaces_live(self):
        self.service.save(capture())
        result = await self.client.post("/api/sessions", json={"name": "Before fix"})
        self.assertEqual(result.status, 201)
        archive = await result.json()
        response = await self.client.get(f"/api/sessions/{archive['id']}/export")
        wire = await response.read()
        self.assertEqual(json.loads(wire.splitlines()[0])["version"], 2)
        await self.client.patch("/api/records/capture/annotation", json={"note": "Changed live", "color": "amber"})
        saved = await (await self.client.get(f"/api/sessions/{archive['id']}/records/capture")).json()
        self.assertNotIn("annotation", saved)
        imported = await self.client.post("/api/sessions/import", data=wire)
        self.assertEqual(imported.status, 201)
        self.assertEqual(self.service.records["capture"]["annotation"]["note"], "Changed live")
        restored = Service(self.directory.name, "test-token", 47821)
        try:
            self.assertEqual(restored.db.execute("SELECT COUNT(*) FROM capture_sessions").fetchone()[0], 2)
        finally:
            restored.db.close()

    async def test_import_is_atomic_and_checks_record_count(self):
        header = {"format": "streamglass-session", "version": 2, "name": "Import", "recordCount": 2}
        raw = (json.dumps(header) + "\n" + json.dumps(capture()) + "\n").encode()
        response = await self.client.post("/api/sessions/import", data=raw)
        self.assertEqual(response.status, 400)
        self.assertEqual((await (await self.client.get("/api/sessions")).json())["sessions"], [])
        self.assertEqual(self.service.records, {})

    async def test_import_rejects_a_normalized_record_that_cannot_be_reimported(self):
        raw = '{"id":"r","url":"https://example.test/","method":"GET","device":"phone","startedAt":1,"state":"complete","logs":[' + ','.join(['1e99'] * 100) + ']}'
        header = json.dumps({"format": "streamglass-session", "version": 2, "name": "Compact", "recordCount": 1})
        with patch("backend.capture_sessions.MAX_RECORD", len(raw.encode()) + 50):
            response = await self.client.post("/api/sessions/import", data=(header + "\n" + raw + "\n").encode())
        self.assertEqual(response.status, 400)
        self.assertEqual((await (await self.client.get("/api/sessions")).json())["sessions"], [])

    async def test_preferences_use_revision_and_survive_restart(self):
        original = await (await self.client.get("/api/productivity")).json()
        config = original["config"]
        config["watches"] = [{"id": "search", "name": "Search", "source": "request", "path": "$.searchId"}]
        response = await self.client.put("/api/productivity", json={"revision": original["revision"], "config": config})
        self.assertEqual(response.status, 200)
        stale = await self.client.put("/api/productivity", json={"revision": original["revision"], "config": config})
        self.assertEqual(stale.status, 409)
        self.service.save(capture())
        analysis = await (await self.client.get("/api/analysis?recordId=capture")).json()
        self.assertEqual(analysis["rows"][0]["watches"][0]["values"], ['"search-1"'])
        restored = Service(self.directory.name, "test-token", 47821)
        try:
            self.assertEqual(restored.productivity["watches"], config["watches"])
        finally:
            restored.db.close()


class RepeatTests(unittest.IsolatedAsyncioTestCase):
    def parameters(self):
        return {"request": {"url": "https://example.test/", "method": "POST", "headers": [], "bodyBase64": ""}, "count": 3, "intervalMs": 0, "timeoutMs": 1000, "stopOnError": True, "confirmSend": True}

    def test_replay_bounds_and_confirmation(self):
        self.assertEqual(validate_repeat(self.parameters()).method, "POST")
        for patch_value in ({"count": 101}, {"count": True}, {"timeoutMs": 0}, {"confirmSend": False}):
            with self.assertRaises(ValueError):
                validate_repeat({**self.parameters(), **patch_value})

    async def test_sequential_results_and_stop_on_error(self):
        from mitmproxy import http
        values = self.parameters()
        message = validate_repeat(values)
        service = SimpleNamespace(master=SimpleNamespace(options=object()), settings={"proxyEnabled": True}, records={}, cancel=lambda *_: None)
        created = []
        class Handler:
            def __init__(self, flow, _):
                self.flow, self.transports = flow, {}
            async def replay(self):
                await asyncio.sleep(0)
                self.flow.response = http.Response.make(503 if len(created) == 2 else 200)
        def flow(*_):
            item = SimpleNamespace(id=str(len(created)), metadata={}, error=None, response=None, killable=False)
            created.append(item)
            return item
        job = {**values, "id": "job", "state": "running", "results": []}
        with patch("backend.repeat_replay.replay_flow", side_effect=flow), patch("mitmproxy.addons.clientplayback.ReplayHandler", Handler):
            await run_job(service, job, message)
        self.assertEqual(job["state"], "stopped")
        self.assertEqual([r["statusCode"] for r in job["results"]], [200, 503])

    async def test_cancel_only_cancels_owned_flow(self):
        from mitmproxy.test.tflow import tflow
        values, entered, cancelled = self.parameters(), asyncio.Event(), []
        flow = tflow()
        service = SimpleNamespace(master=SimpleNamespace(options=object()), settings={"proxyEnabled": True}, records={}, cancel=lambda record_id, _: cancelled.append(record_id))
        class Handler:
            def __init__(self, *_):
                self.transports = {}
            async def replay(self):
                entered.set()
                await asyncio.Event().wait()
        job = {**values, "id": "job", "state": "running", "results": []}
        with patch("backend.repeat_replay.replay_flow", return_value=flow), patch("mitmproxy.addons.clientplayback.ReplayHandler", Handler):
            task = asyncio.create_task(run_job(service, job, validate_repeat(values)))
            await entered.wait()
            task.cancel()
            await task
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual(cancelled, [flow.id])

    async def test_proxy_stop_cancels_sleeping_job_before_restart(self):
        from backend.repeat_replay import stop_jobs
        entered = asyncio.Event()
        sent = []
        async def sleeping():
            entered.set()
            await asyncio.sleep(60)
            sent.append("unexpected resumed request")
        task = asyncio.create_task(sleeping())
        job = {"state": "running", "task": task}
        service = SimpleNamespace(replay_jobs={"job": job})
        await entered.wait()
        await stop_jobs(service)
        self.assertEqual(job["state"], "cancelled")
        self.assertTrue(task.cancelled())
        self.assertEqual(sent, [])

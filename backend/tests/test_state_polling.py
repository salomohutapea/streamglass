import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer
from backend.api import create_app
from backend.service import Service

ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII="


def stream(record_id="stream", events=3):
    return {"id": record_id, "kind": "request", "url": "https://api.example.test/sse", "method": "GET", "device": "phone", "startedAt": 100.0,
            "state": "streaming", "eventCount": events, "clientIsLocal": True,
            "application": {"id": "bundle:test.app", "name": "Test App", "kind": "application", "icon": ICON},
            "request": {"url": "https://api.example.test/sse", "method": "GET", "headers": [], "body": "", "bodyBase64": ""},
            "response": {"statusCode": 200, "headers": [["content-type", "text/event-stream"]], "body": "", "bodyBase64": ""},
            "events": [{"event": "message", "data": f'{{"n":{n}}}', "sequence": n + 1, "raw": f'data: {{"n":{n}}}\n\n', "rawBase64": "ZGF0YQ=="} for n in range(events)]}


class StatePollingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "test-token", 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={"Authorization": "Bearer test-token", "Host": "127.0.0.1:47821"})
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def get(self, path):
        response = await self.client.get(path)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def test_rows_omit_icons_and_unchanged_polls_are_tiny(self):
        self.service.save(stream())
        first = await self.get("/api/state")
        row = first["records"][0]
        self.assertNotIn("icon", row["application"])
        self.assertEqual(first["applicationIcons"], {"bundle:test.app": ICON})
        self.assertGreater(row["rev"], 0)
        self.assertEqual(await self.get(f"/api/state?etag={first['etag']}"), {"unchanged": True, "etag": first["etag"]})
        # A summary change without a revision bump, such as a pause toggle, still changes the etag.
        self.service.settings["capturePaused"] = True
        changed = await self.get(f"/api/state?etag={first['etag']}")
        self.assertNotEqual(changed["etag"], first["etag"])
        self.assertTrue(changed["settings"]["capturePaused"])
        # A saved record bumps its row revision.
        record = self.service.records["stream"]
        record["eventCount"] = 4
        self.service.save(record)
        after = await self.get(f"/api/state?etag={changed['etag']}")
        self.assertGreater(after["records"][0]["rev"], row["rev"])
        # The service's own snapshot keeps the same shape as the endpoint.
        self.assertEqual(self.service.state()["records"], after["records"])

    async def test_since_returns_changed_rows_and_order_only(self):
        self.service.save(stream("a"))
        self.service.save({**stream("b"), "startedAt": 200.0})
        first = await self.get("/api/state")
        since = f"{first['instance']}:{first['revision']}"
        record = self.service.records["a"]
        record["eventCount"] = 9
        self.service.save(record)
        delta = await self.get(f"/api/state?etag={first['etag']}&since={since}")
        self.assertTrue(delta["delta"])
        self.assertEqual([row["id"] for row in delta["rows"]], ["a"])
        self.assertEqual(delta["ids"], ["b", "a"])
        self.assertNotIn("applicationIcons", delta)
        self.assertNotIn("records", delta)
        self.service.forget_record("b")
        self.service.changed()
        removed = await self.get(f"/api/state?since={since}")
        self.assertEqual(removed["ids"], ["a"])
        # Another engine instance, or a revision from the future, gets a full snapshot.
        for other in ("other:1", f"{first['instance']}:999999", "garbage"):
            full = await self.get(f"/api/state?since={other}")
            self.assertNotIn("delta", full)
            self.assertEqual([row["id"] for row in full["records"]], ["a"])

    async def test_record_events_compact_and_incremental(self):
        self.service.save(stream(events=3))
        full = await self.get("/api/records/stream")
        self.assertIn("rawBase64", full["events"][0])
        self.assertNotIn("eventsFrom", full)
        compact = await self.get("/api/records/stream?compact=1")
        self.assertEqual(compact["eventsFrom"], 0)
        self.assertEqual([event["data"] for event in compact["events"]], ['{"n":0}', '{"n":1}', '{"n":2}'])
        self.assertTrue(all("raw" not in event and "rawBase64" not in event for event in compact["events"]))
        later = await self.get("/api/records/stream?compact=1&afterEvent=2")
        self.assertEqual((later["eventsFrom"], [event["sequence"] for event in later["events"]]), (2, [3]))
        # An offset past the retained events falls back to the whole list.
        self.assertEqual((await self.get("/api/records/stream?compact=1&afterEvent=9"))["eventsFrom"], 0)

    async def test_pending_endpoint_lists_gates_only(self):
        self.service.pending["gate"] = {"token": "gate", "recordId": "stream", "stage": "request", "value": {}, "future": object(), "original": {}}
        value = await self.get("/api/pending")
        self.assertEqual(value, {"capturePaused": False, "pending": [{"token": "gate", "recordId": "stream", "stage": "request", "value": {}}]})

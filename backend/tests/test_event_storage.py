import random
import tempfile
import unittest

from backend.service import Service, MAX_RECORDS
from backend.sse import exported, wire_event
from backend.timings import GapStats, gap_stats


def stream(record_id="stream", events=0, started=100.0):
    return {"id": record_id, "kind": "request", "url": "https://api.example.test/sse", "method": "GET", "device": "phone", "startedAt": started,
            "state": "streaming", "eventCount": events,
            "request": {"url": "https://api.example.test/sse", "method": "GET", "headers": [], "body": "", "bodyBase64": ""},
            "response": {"statusCode": 200, "headers": [["content-type", "text/event-stream"]], "body": "", "bodyBase64": ""},
            "events": [{"event": "message", "data": f"{n}", "sequence": n + 1, "raw": f"data: {n}\n\n"} for n in range(events)]}


class EventStorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "test-token", 47821)

    def tearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    def rows(self, record_id="stream"):
        return [row[0] for row in self.service.db.execute("SELECT seq FROM events WHERE record=? ORDER BY seq", (record_id,))]

    def test_events_append_without_rewriting_the_record_row(self):
        record = stream()
        self.service.save(record)
        for n in range(5):
            record["events"].append({"event": "message", "data": f"{n}", "sequence": n + 1, "raw": f"data: {n}\n\n"})
            record["eventCount"] = n + 1
            self.service.save(record)
        self.assertEqual(self.rows(), [0, 1, 2, 3, 4])
        payload = self.service.db.execute("SELECT payload FROM records WHERE id='stream'").fetchone()[0]
        self.assertIn('"events": []', payload)
        # A shorter list (an edited or trimmed history) rewrites the rows.
        record["events"] = record["events"][:2]
        self.service.save(record)
        self.assertEqual(self.rows(), [0, 1])

    def test_reload_restores_events_and_sizes(self):
        record = stream(events=3)
        self.service.save(record)
        size = self.service.record_sizes["stream"]
        self.service.db.close()
        restored = Service(self.directory.name, "test-token", 47821)
        try:
            self.assertEqual(restored.records["stream"]["events"], record["events"])
            self.assertEqual(restored.record_sizes["stream"], size)
        finally:
            restored.db.close()
        self.service = Service(self.directory.name, "test-token", 47821)

    def test_eviction_and_delete_remove_event_rows(self):
        self.service.save(stream("old", events=2, started=1.0))
        for n in range(MAX_RECORDS):
            self.service.save({**stream(f"r{n}", started=10.0 + n), "events": []})
        self.assertNotIn("old", self.service.records)
        self.assertEqual(self.rows("old"), [])
        self.assertEqual(len(self.service.records), MAX_RECORDS)
        self.service.forget_record("r0")
        self.assertNotIn("r0", self.service.records)
        self.service.discard_captures()
        self.assertEqual(self.service.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)

    def test_allowlist_changes_rebuild_the_retention_index(self):
        self.service.save(stream(events=1))
        self.assertIn("stream", self.service.retention_index()["groups"]["limited"]["ids"])
        self.service.settings["tlsDomains"] = ["api.example.test"]
        self.assertNotIn("stream", self.service.retention_index()["groups"]["limited"]["ids"])

    def test_exports_restore_raw_base64(self):
        event = {"sequence": 1, "raw": "data: é\n\n"}
        self.assertEqual(wire_event(event)["rawBase64"], "ZGF0YTogw6kKCg==")
        self.assertIs(wire_event({**event, "rawBase64": "kept"})["rawBase64"], "kept")
        self.assertEqual(exported({"id": "x", "events": [event]})["events"][0]["rawBase64"], "ZGF0YTogw6kKCg==")

    def test_running_gap_stats_match_sorted_stats(self):
        rng, stats, gaps = random.Random(7), GapStats(limit=50), []
        for _ in range(200):
            gap = rng.uniform(0, 100)
            gaps.append(gap)
            result = stats.add(gap)
        expected = gap_stats(gaps[-50:])
        self.assertEqual({key: result[key] for key in ("count", "minMs", "p95Ms", "maxMs")}, {key: expected[key] for key in ("count", "minMs", "p95Ms", "maxMs")})
        self.assertAlmostEqual(result["avgMs"], expected["avgMs"])

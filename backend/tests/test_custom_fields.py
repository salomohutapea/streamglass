import asyncio
import copy
import json
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from backend.api import create_app
from backend import custom_fields
from backend.custom_fields import evaluate
from backend.productivity import DEFAULT, migrate, validate
from backend.service import Service

URL = "https://api.example.test/search?q=1"


def field(identifier, path, **changes):
    return {"id": identifier, "name": identifier.title(), "pattern": "*", "method": "*", "source": "response", "path": path, **changes}


def where(path, **changes):
    return {"pattern": "*", "method": "*", "source": "response", "path": path, **changes}


def multi(identifier, *locations):
    return {"id": identifier, "name": identifier.title(), "locations": list(locations)}


def nested(flat):
    return {"id": flat["id"], "name": flat["name"], "locations": [{key: flat[key] for key in ("pattern", "method", "source", "path")}]}


def config(*fields):
    return {**copy.deepcopy(DEFAULT), "fields": list(fields)}


def capture(record_id="capture", **changes):
    return {**base(record_id), **changes}


def base(record_id):
    return {"id": record_id, "kind": "request", "url": URL, "method": "POST", "device": "phone", "startedAt": 100.0, "endedAt": 101.0,
            "state": "complete", "eventCount": 0, "events": [],
            "request": {"headers": [["X-Trace", "t-1"]], "body": '{"searchId":"s-1"}', "bodyBase64": ""},
            "response": {"statusCode": 200, "headers": [["Content-Type", "application/json"], ["x-trace", "r-1"], ["X-TRACE", "r-2"]], "body": '{"id":7,"name":"Ann","tags":["a","b","a"],"nested":{"k":1},"nothing":null}', "bodyBase64": ""}}


def events(count, start=0):
    return [{"event": "message", "sequence": n + 1, "data": json.dumps({"n": n, "kind": "even" if n % 2 == 0 else "odd"})} for n in range(start, start + count)]


class FieldTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "test-token", 47821)

    def tearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    def use(self, *fields):
        self.service.productivity = validate(config(*fields))
        self.service.invalidate_fields()

    def rows(self):
        """Rows after the background worker has caught up (driven synchronously)."""
        custom_fields.drain(self.service, budget=1e9)
        return {row["id"]: row for row in self.service.state_rows()[0]}

    def results(self, record_id="capture"):
        return self.rows()[record_id].get("fields", [])


class ValidationTests(unittest.TestCase):
    def test_accepts_all_sources(self):
        fields = [field("a", "$.a"), field("b", "$.b", source="request", method="post", pattern="https://*/x"), field("c", "$.c", source="event"),
                  field("d", "X-Trace", source="requestHeader"), field("e", "content-type", source="responseHeader", method="GET")]
        self.assertEqual(validate(config(*fields))["fields"], [nested(item) for item in fields])

    def test_rejects_bad_fields(self):
        for bad in (field("a", "$.a", source="body"), field("a", "a b", source="requestHeader"), field("a", "Bad Header", source="responseHeader"), field("a", "", source="responseHeader"),
                    field("a", "a.b"), field("a", "$..a"), field("a", "$[?(@.x)]", source="event"), field("a", "$.a", method="GE T"), field("a", "$.a", method=""),
                    field("a", "$.a", pattern=""), field("a", "$.a", pattern="x" * 4097), field("a", "$.a", method="x" * 65), field("a", "$.a", extra=1), field("a" * 129, "$.a"),
                    {k: v for k, v in field("a", "$.a").items() if k != "method"}):
            with self.assertRaises(ValueError, msg=bad):
                validate(config(bad))
        with self.assertRaises(ValueError):
            validate(config(field("same", "$.a"), field("same", "$.b")))
        with self.assertRaises(ValueError):
            validate(config(*[field(str(n), "$.a") for n in range(51)]))
        validate(config(*[field(str(n), "$.a") for n in range(50)]))

    def test_legacy_watches_migrate(self):
        legacy = {key: value for key, value in copy.deepcopy(DEFAULT).items() if key != "fields"}
        legacy["watches"] = [{"id": "w", "name": "Watch", "source": "event", "path": "$.a"}]
        migrated = validate(legacy)
        self.assertNotIn("watches", migrated)
        self.assertEqual(migrated["fields"], [multi("w", where("$.a", source="event")) | {"name": "Watch"}])
        self.assertIn("watches", legacy)
        self.assertEqual(migrate(copy.deepcopy(DEFAULT)), DEFAULT)
        with self.assertRaises(ValueError):
            validate({**legacy, "fields": []})
        legacy["watches"] = [{"id": "w", "name": "Watch", "source": "event", "path": "$..a"}]
        with self.assertRaises(ValueError):
            validate(legacy)

    def test_flat_fields_migrate_to_locations(self):
        flat = {"id": "f", "name": "F", "pattern": "https://x/*", "method": "GET", "source": "event", "path": "$.a"}
        migrated = migrate({**copy.deepcopy(DEFAULT), "fields": [flat, multi("g", where("$.b"))]})
        self.assertEqual(migrated["fields"], [{"id": "f", "name": "F", "locations": [{"pattern": "https://x/*", "method": "GET", "source": "event", "path": "$.a"}]}, multi("g", where("$.b")) | {"name": "G"}])
        self.assertEqual(migrate(copy.deepcopy(migrated)), migrated)
        self.assertEqual(flat["path"], "$.a")
        self.assertEqual(validate(migrated)["fields"], migrated["fields"])

    def test_rejects_mixed_shapes(self):
        mixed = {**multi("m", where("$.a")), "path": "$.b"}
        both = {**multi("m", where("$.a")), "pattern": "*", "method": "*", "source": "response", "path": "$.b"}
        for bad in (mixed, both, {**field("m", "$.a"), "locations": [where("$.a")]}):
            with self.assertRaises(ValueError, msg=bad):
                validate(config(bad))

    def test_location_validation(self):
        good = where("$.a")
        validate(config(multi("ten", *[where(f"$.a{n}") for n in range(10)])))
        for locations in ([], [where("$.a")] * 11, "none", None, [good, "x"], [good, {**good, "source": "body"}], [good, {**good, "extra": 1}], [good, {k: v for k, v in good.items() if k != "method"}],
                          [good, where("$..a")], [good, where("a b", source="requestHeader")], [good, where("$.a", method="GE T")], [good, where("$.a", pattern="")]):
            with self.assertRaises(ValueError, msg=locations):
                validate(config({"id": "a", "name": "A", "locations": locations}))
        with self.assertRaises(ValueError):
            validate(config({"id": "a", "name": "A"}))

    def test_service_migrates_persisted_legacy_config(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, "test-token", 47821)
            try:
                legacy = {key: value for key, value in copy.deepcopy(DEFAULT).items() if key != "fields"}
                legacy["watches"] = [{"id": "w", "name": "Watch", "source": "response", "path": "$.id"}]
                service.db.execute("INSERT OR REPLACE INTO config VALUES ('productivity', ?)", (json.dumps(legacy),))
                service.db.commit()
            finally:
                service.db.close()
            restored = Service(directory, "test-token", 47821)
            try:
                self.assertEqual(restored.productivity["fields"][0]["locations"], [where("$.id")])
                self.assertNotIn("watches", restored.productivity)
                self.assertEqual(restored.state_summary()["productivity"]["fields"], 1)
            finally:
                restored.db.close()


class ExtractionTests(FieldTestCase):
    def test_pattern_and_method_decide_which_rows_carry_fields(self):
        self.use(field("id", "$.id", pattern="https://api.example.test/*", method="post"), field("other", "$.id", pattern="https://other.test/*"), field("get", "$.id", method="GET"))
        self.service.save(capture())
        self.service.save(capture("elsewhere", url="https://cdn.example.test/a"))
        rows = self.rows()
        self.assertEqual([item["id"] for item in rows["capture"]["fields"]], ["id"])
        self.assertNotIn("fields", rows["elsewhere"])
        self.assertEqual(self.service.state_summary()["productivity"]["fields"], 3)
        self.service.save(capture("tunnel", kind="tunnel"))
        self.assertNotIn("fields", self.rows()["tunnel"])

    def test_body_values_display_and_cap(self):
        self.use(field("name", "$.name"), field("id", "$.id"), field("obj", "$.nested"), field("nil", "$.nothing"), field("tags", "$.tags[*]"), field("absent", "$.absent"),
                 field("req", "$.searchId", source="request"), field("many", "$.items[*]"), field("long", "$.long"))
        record = capture()
        record["response"]["body"] = json.dumps({"id": 7, "name": "Ann", "tags": ["a", "b", "a"], "nested": {"k": [1, "é"]}, "nothing": None, "items": list(range(20)), "long": "x" * 300})
        self.service.save(record)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual(by_id["name"], {"id": "name", "name": "Name", "locations": [{"source": "response", "path": "$.name"}], "values": ["Ann"], "summaries": [None], "count": 1, "state": "found", "limited": False})
        self.assertEqual(by_id["id"]["values"], ["7"])
        self.assertEqual(by_id["obj"]["values"], [json.dumps({"k": [1, "é"]}, ensure_ascii=False)])
        self.assertEqual(by_id["nil"]["values"], ["null"])
        self.assertEqual((by_id["tags"]["values"], by_id["tags"]["count"], by_id["tags"]["limited"]), (["a", "b"], 2, False))
        self.assertEqual(by_id["absent"], {**by_id["absent"], "values": [], "count": 0, "state": "missing", "limited": False})
        self.assertEqual(by_id["req"]["values"], ["s-1"])
        self.assertEqual(by_id["many"]["values"], ["0", "1", "2", "3", "4"])
        self.assertTrue(by_id["many"]["limited"])
        self.assertGreater(by_id["many"]["count"], 5)
        self.assertEqual((len(by_id["long"]["values"][0]), by_id["long"]["limited"]), (256, True))

    def test_summaries_align_with_values(self):
        self.use(field("arr", "$.arr"), field("one", "$.one"), field("empty", "$.empty"), field("obj", "$.obj"), field("solo", "$.solo"), field("none", "$.none"), field("scalars", "$.mix[*]"),
                 field("hdr", "x-trace", source="responseHeader"), field("tags", "$.tags[*]"))
        record = capture()
        record["response"]["body"] = json.dumps({"arr": [1, 2, 3], "one": ["a"], "empty": [], "obj": {"a": 1, "b": 2}, "solo": {"a": 1}, "none": None, "mix": ["s", 5, True, [1, 2], {"k": 1}], "tags": ["a", "b", "a"]})
        self.service.save(record)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual((by_id["arr"]["values"], by_id["arr"]["summaries"]), (["[1, 2, 3]"], ["[3 items]"]))
        self.assertEqual(by_id["one"]["summaries"], ["[1 item]"])
        self.assertEqual(by_id["empty"]["summaries"], ["[0 items]"])
        self.assertEqual(by_id["obj"]["summaries"], ["{2 keys}"])
        self.assertEqual(by_id["solo"]["summaries"], ["{1 key}"])
        self.assertEqual((by_id["none"]["values"], by_id["none"]["summaries"]), (["null"], [None]))
        self.assertEqual(by_id["scalars"]["values"], ["s", "5", "true", "[1, 2]", '{"k": 1}'])
        self.assertEqual(by_id["scalars"]["summaries"], [None, None, None, "[2 items]", "{1 key}"])
        self.assertEqual((by_id["hdr"]["values"], by_id["hdr"]["summaries"]), (["r-1", "r-2"], [None, None]))
        self.assertEqual((by_id["tags"]["values"], by_id["tags"]["summaries"]), (["a", "b"], [None, None]))

    def test_full_values_are_not_cut_at_the_row_cap(self):
        self.use(field("obj", "$.big"), field("text", "$.text"), field("huge", "$.huge"))
        big = {"items": [{"n": n, "label": "x" * 20} for n in range(40)]}
        record = capture()
        record["response"]["body"] = json.dumps({"big": big, "text": "y" * 300, "huge": "z" * (custom_fields.MAX_FULL_TEXT + 10)})
        self.service.save(record)
        row = {item["id"]: item for item in self.results()}
        self.assertEqual((len(row["obj"]["values"][0]), row["obj"]["limited"]), (256, True))
        stored = self.service.records["capture"]
        full = {item["id"]: item for item in evaluate(self.service, stored, full=True)}
        self.assertEqual(json.loads(full["obj"]["values"][0]), big)
        self.assertEqual(full["obj"]["summaries"], ["{1 key}"])
        self.assertFalse(full["obj"]["limited"])
        self.assertEqual((full["text"]["values"], full["text"]["limited"]), (["y" * 300], False))
        self.assertEqual((len(full["huge"]["values"][0]), full["huge"]["limited"]), (custom_fields.MAX_FULL_TEXT, True))
        self.assertEqual(len({item["id"]: item for item in self.results()}["obj"]["values"][0]), 256)

    def test_header_values_are_case_insensitive(self):
        self.use(field("resp", "x-Trace", source="responseHeader"), field("req", "X-TRACE", source="requestHeader"), field("none", "x-none", source="responseHeader"))
        self.service.save(capture())
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual(by_id["resp"]["values"], ["r-1", "r-2"])
        self.assertEqual(by_id["req"]["values"], ["t-1"])
        self.assertEqual(by_id["none"]["state"], "missing")

    def test_states_pending_missing_and_unknown(self):
        self.use(field("res", "$.id"), field("req", "$.id", source="request"), field("header", "x-a", source="responseHeader"), field("event", "$.n", source="event"))
        self.service.save(capture(state="streaming", response={"headers": [], "body": ""}, request={"headers": [], "body": ""}))
        by_id = {item["id"]: item["state"] for item in self.results()}
        self.assertEqual(by_id, {"res": "pending", "req": "missing", "header": "pending", "event": "pending"})
        self.service.save(capture(state="complete", response={"headers": [], "body": ""}, request={"headers": [], "body": ""}))
        self.assertEqual({item["state"] for item in self.results()}, {"missing"})

    def test_unknown_notes(self):
        self.use(field("res", "$.id"), field("req", "$.id", source="request"), field("event", "$.n", source="event"))
        record = capture(request={"headers": [], "body": "plain"}, response={"headers": [], "body": "", "bodyUnavailable": True}, eventCount=3, events=events(1))
        self.service.save(record)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual((by_id["res"]["state"], by_id["res"]["note"]), ("unknown", "Body was not fully retained"))
        self.assertEqual((by_id["req"]["state"], by_id["req"]["note"]), ("unknown", "Request body is not JSON"))
        self.assertEqual(by_id["event"]["state"], "found")
        self.service.save({**record, "events": [], "eventCount": 3})
        self.assertEqual({item["id"]: item.get("note") for item in self.results()}["event"], "SSE event history is incomplete")
        self.use(field("event", "$.absent", source="event"))
        self.service.save({**record, "events": events(1), "eventCount": 1, "captureWarning": "limit"})
        self.assertEqual((self.results()[0]["state"], self.results()[0]["note"]), ("unknown", "SSE event history is incomplete"))
        self.use(field("res", "$.id"))
        self.service.save(capture(response={"headers": [], "body": "x" * (4 * 1024 * 1024 + 1)}))
        self.assertEqual(self.results()[0]["note"], "Body exceeds the 4 MiB field budget")

    def test_select_errors_are_unknown_with_the_message(self):
        self.use(field("wide", "$[*][*]"))
        self.service.save(capture(response={"headers": [], "body": json.dumps([list(range(2))] * 10001)}))
        item = self.results()[0]
        self.assertEqual((item["state"], item["limited"]), ("unknown", True))
        self.assertIn("10,000", item["note"])

    def test_event_values_distinct_and_limited(self):
        self.use(field("kind", "$.kind", source="event"), field("n", "$.n", source="event"))
        self.service.save(capture(eventCount=10, events=events(10) + [{"event": "ping", "data": "not json"}, {"event": "x", "data": ""}]))
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual((by_id["kind"]["values"], by_id["kind"]["limited"]), (["even", "odd"], False))
        self.assertEqual((by_id["n"]["values"], by_id["n"]["limited"]), (["0", "1", "2", "3", "4"], True))


class LocationTests(FieldTestCase):
    STREAM, POLL = "https://stream.example.test/search", "https://poll.example.test/search"

    def search_id(self, **changes):
        return multi("searchid", where("$.searchId", pattern="https://stream.example.test/*", source="event"), where("$.searchId", pattern="https://poll.example.test/*", method="GET"), **changes)

    def test_each_record_matches_only_its_own_location(self):
        self.use(self.search_id())
        stream_events = [{"event": "message", "sequence": 1, "data": '{"searchId":"s-9"}'}]
        self.service.save(capture("stream", url=self.STREAM, method="POST", eventCount=1, events=stream_events, response={"statusCode": 200, "headers": [], "body": ""}))
        poll_body = '{"searchId":"p-3"}'
        self.service.save(capture("poll", url=self.POLL, method="GET", response={"statusCode": 200, "headers": [], "body": poll_body}))
        self.service.save(capture("wrong-method", url=self.POLL, method="POST"))
        self.service.save(capture("other", url="https://other.example.test/x"))
        rows = self.rows()
        stream, poll = rows["stream"]["fields"][0], rows["poll"]["fields"][0]
        self.assertEqual((stream["values"], stream["state"], stream["locations"]), (["s-9"], "found", [{"source": "event", "path": "$.searchId"}]))
        self.assertEqual((poll["values"], poll["state"], poll["locations"]), (["p-3"], "found", [{"source": "response", "path": "$.searchId"}]))
        self.assertEqual((stream["id"], stream["name"], set(stream)), ("searchid", "Searchid", {"id", "name", "locations", "values", "summaries", "count", "state", "limited"}))
        self.assertNotIn("fields", rows["wrong-method"])
        self.assertNotIn("fields", rows["other"])

    def test_one_record_matching_two_locations_merges_distinct_values(self):
        self.use(multi("merged", where("$.a"), where("$.b[*]"), where("$.c", source="request"), where("x-trace", source="responseHeader")))
        record = capture()
        record["response"]["body"] = json.dumps({"a": "x", "b": ["x", "y", {"k": 1}], "z": 1})
        record["request"]["body"] = json.dumps({"c": ["r-1", "r-2"]})
        self.service.save(record)
        item = self.results()[0]
        self.assertEqual(item["values"], ["x", "y", '{"k": 1}', '["r-1", "r-2"]', "r-1"])
        self.assertEqual(item["summaries"], [None, None, "{1 key}", "[2 items]", None])
        self.assertEqual((item["count"], item["limited"], item["state"]), (6, True, "found"))
        self.assertEqual([loc["source"] for loc in item["locations"]], ["response", "response", "request", "responseHeader"])

    def test_merged_values_are_distinct_and_unlimited_when_they_fit(self):
        self.use(multi("merged", where("$.a"), where("$.b[*]")))
        record = capture()
        record["response"]["body"] = json.dumps({"a": "x", "b": ["x", "y", "x"]})
        self.service.save(record)
        item = self.results()[0]
        self.assertEqual((item["values"], item["count"], item["limited"]), (["x", "y"], 2, False))

    def test_merged_cap_marks_limited_and_full_mode_keeps_long_values(self):
        self.use(multi("merged", where("$.a[*]"), where("$.b[*]"), where("$.big")))
        record = capture()
        record["response"]["body"] = json.dumps({"a": ["1", "2", "3"], "b": ["3", "4", "5", "6"], "big": {"items": ["x" * 30] * 20}})
        self.service.save(record)
        item = self.results()[0]
        self.assertEqual((item["values"], item["limited"]), (["1", "2", "3", "4", "5"], True))
        self.assertGreater(item["count"], 5)
        self.use(multi("merged", where("$.big"), where("$.a[*]")))
        item = evaluate(self.service, self.service.records["capture"], full=True)[0]
        self.assertEqual(json.loads(item["values"][0]), {"items": ["x" * 30] * 20})
        self.assertEqual((item["values"][1:], item["limited"]), (["1", "2", "3"], False))
        self.assertTrue(self.results()[0]["limited"])

    def test_body_shared_by_two_locations_is_parsed_once(self):
        self.use(multi("two", where("$.id"), where("$.name")), field("other", "$.tags[*]"))
        self.service.save(capture())
        with patch("backend.custom_fields.json.loads", wraps=json.loads) as loads:
            by_id = {item["id"]: item for item in self.results()}
            self.assertEqual(loads.call_count, 1)
        self.assertEqual(by_id["two"]["values"], ["7", "Ann"])

    def test_events_are_parsed_once_for_all_event_locations(self):
        self.use(multi("kinds", where("$.kind", source="event"), where("$.n", source="event")))
        self.service.save(capture(eventCount=4, events=events(4)))
        with patch("backend.custom_fields.json.loads", wraps=json.loads) as loads:
            item = self.results()[0]
            self.assertEqual(loads.call_count, 4)
        self.assertEqual(item["values"], ["even", "odd", "0", "1", "2"])
        self.assertTrue(item["limited"])

    def test_state_precedence_across_locations(self):
        self.use(multi("pending", where("$.nope", source="request"), where("$.nope")), multi("request-only", where("$.nope", source="request"), where("x-none", source="requestHeader")),
                 multi("found", where("$.nope"), where("$.searchId", source="request")), multi("unknown", where("$.id"), where("$.nope", source="request")))
        streaming = capture(state="streaming")
        streaming["response"] = {**streaming["response"], "body": "not json"}
        self.service.save(streaming)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual({key: item["state"] for key, item in by_id.items()}, {"pending": "pending", "request-only": "missing", "found": "found", "unknown": "pending"})
        self.assertEqual(by_id["found"]["values"], ["s-1"])
        done = capture(state="complete")
        done["response"] = {**done["response"], "body": "not json"}
        self.service.save(done)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual({key: item["state"] for key, item in by_id.items()}, {"pending": "unknown", "request-only": "missing", "found": "found", "unknown": "unknown"})
        self.assertEqual(by_id["unknown"]["note"], "Response body is not JSON")
        self.assertNotIn("note", by_id["found"])
        self.assertNotIn("note", by_id["request-only"])

    def test_first_note_and_incomplete_event_history(self):
        self.use(multi("notes", where("$.id", source="request"), where("$.id", source="response", pattern="*search*")), multi("history", where("$.n", source="event"), where("x-none", source="requestHeader")))
        unavailable = capture(eventCount=3, events=[])
        unavailable["request"] = {**unavailable["request"], "bodyUnavailable": True}
        unavailable["response"] = {**unavailable["response"], "body": "not json"}
        self.service.save(unavailable)
        by_id = {item["id"]: item for item in self.results()}
        self.assertEqual((by_id["notes"]["state"], by_id["notes"]["note"]), ("unknown", "Body was not fully retained"))
        self.assertEqual((by_id["history"]["state"], by_id["history"]["note"]), ("unknown", "SSE event history is incomplete"))
        found = capture(eventCount=3, events=[])
        self.service.save(found)
        self.assertEqual([item["state"] for item in self.results()], ["found", "unknown"])
        self.assertNotIn("note", self.results()[0])


class CacheTests(FieldTestCase):
    def test_unchanged_revision_reuses_results(self):
        self.use(field("id", "$.id"), field("n", "$.n", source="event"))
        self.service.save(capture(eventCount=2, events=events(2)))
        first = self.results()
        with patch("backend.custom_fields.json.loads", side_effect=AssertionError("parsed")):
            self.assertIs(evaluate(self.service, self.service.records["capture"]), self.service.field_cache["capture"]["results"])
            self.assertEqual(self.results(), first)
        self.assertEqual(self.service.field_cache["capture"]["rev"], self.service.record_revs["capture"])

    def test_no_match_is_cached_and_not_reevaluated(self):
        self.use(field("id", "$.id", pattern="https://nowhere.test/*"))
        self.service.save(capture())
        self.assertNotIn("fields", self.rows()["capture"])
        record = self.service.records["capture"]
        with patch("backend.custom_fields.fnmatch.fnmatchcase", side_effect=AssertionError("matched")):
            self.assertEqual(evaluate(self.service, record), [])
            self.service.record_revs["capture"] += 1
            self.assertEqual(evaluate(self.service, record), [])

    def test_body_is_parsed_once_per_body_object(self):
        self.use(field("id", "$.id"))
        self.service.save(capture())
        record = self.service.records["capture"]
        self.assertEqual(self.results()[0]["values"], ["7"])
        with patch("backend.custom_fields.json.loads", wraps=json.loads) as loads:
            record["eventCount"] = 1
            self.service.save(record)
            self.assertEqual(self.results()[0]["values"], ["7"])
            self.assertEqual(loads.call_count, 0)
            record["response"] = {**record["response"], "body": '{"id":8}'}
            self.service.save(record)
            self.assertEqual(self.results()[0]["values"], ["8"])
            self.assertEqual(loads.call_count, 1)

    def test_events_are_incremental(self):
        self.use(field("n", "$.n", source="event"), field("kind", "$.kind", source="event"))
        record = capture(state="streaming", eventCount=3, events=events(3))
        self.service.save(record)
        self.assertEqual(self.results()[0]["values"], ["0", "1", "2"])
        with patch("backend.custom_fields.json.loads", wraps=json.loads) as loads:
            record["events"].extend(events(2, 3))
            record["eventCount"] = 5
            self.service.save(record)
            self.assertEqual(self.results()[0]["values"], ["0", "1", "2", "3", "4"])
            self.assertEqual(loads.call_count, 2)
            loads.reset_mock()
            record["events"].extend(events(3, 5))
            self.service.save(record)
            self.assertEqual(self.results()[0]["limited"], True)
            self.assertEqual(loads.call_count, 3)
            self.assertEqual(self.results()[1]["values"], ["even", "odd"])
            # The full "n" field stops collecting, but "kind" still reads each new event once.
            loads.reset_mock()
            record["events"].extend(events(50, 8))
            self.service.save(record)
            self.assertEqual(self.results()[0]["values"], ["0", "1", "2", "3", "4"])
            self.assertEqual(loads.call_count, 50)

    def test_saturated_fields_skip_later_events(self):
        self.use(field("n", "$.n", source="event"))
        record = capture(state="streaming", eventCount=10, events=events(10))
        self.service.save(record)
        with patch("backend.custom_fields.json.loads", wraps=json.loads) as loads:
            record["events"].extend(events(100, 10))
            self.service.save(record)
            self.assertEqual(loads.call_count, 0)

    def test_shorter_event_list_restarts(self):
        self.use(field("n", "$.n", source="event"))
        record = capture(state="streaming", eventCount=4, events=events(4))
        self.service.save(record)
        record["events"] = events(2, 10)
        self.service.save(record)
        self.assertEqual(self.results()[0]["values"], ["10", "11"])

    def test_scan_limit_marks_unknown(self):
        self.use(field("missing", "$.nope", source="event"))
        self.service.save(capture(eventCount=custom_fields.MAX_EVENTS + 2, events=events(custom_fields.MAX_EVENTS + 2)))
        item = self.results()[0]
        self.assertEqual((item["state"], item["limited"], item["note"]), ("unknown", True, "SSE event scan limit reached"))

    def test_full_cache_is_bounded_lru_and_separate(self):
        self.use(field("id", "$.id"))
        for n in range(5):
            self.service.save(capture(f"r{n}"))
        for n in range(4):
            evaluate(self.service, self.service.records[f"r{n}"], full=True)
        self.assertEqual(list(self.service.field_full_cache), ["r0", "r1", "r2", "r3"])
        self.assertEqual(self.service.field_cache, {})
        results = evaluate(self.service, self.service.records["r0"], full=True)
        self.assertIs(evaluate(self.service, self.service.records["r0"], full=True), results)
        self.assertEqual(list(self.service.field_full_cache), ["r1", "r2", "r3", "r0"])
        evaluate(self.service, self.service.records["r4"], full=True)
        self.assertEqual(list(self.service.field_full_cache), ["r2", "r3", "r0", "r4"])
        self.rows()
        self.assertEqual(len(self.service.field_cache), 5)
        self.assertEqual(len(self.service.field_full_cache), 4)

    def test_forget_and_discard_drop_full_entries(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        self.service.save(capture("b"))
        for name in "ab":
            evaluate(self.service, self.service.records[name], full=True)
        self.service.forget_record("a")
        self.assertEqual(set(self.service.field_full_cache), {"b"})
        self.service.discard_captures()
        self.assertEqual(self.service.field_full_cache, {})

    def test_forget_and_discard_drop_entries(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        self.service.save(capture("b"))
        self.rows()
        self.assertEqual(set(self.service.field_cache), {"a", "b"})
        self.service.forget_record("a")
        self.assertEqual(set(self.service.field_cache), {"b"})
        self.service.discard_captures()
        self.assertEqual(self.service.field_cache, {})


class BackgroundTests(FieldTestCase):
    def counting(self):
        calls = []
        original = custom_fields.evaluate
        def spy(service, record, full=False):
            calls.append(record["id"])
            return original(service, record, full)
        return calls, patch.object(custom_fields, "evaluate", spy)

    def test_state_rows_never_evaluate(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        with patch.object(custom_fields, "evaluate", side_effect=AssertionError("evaluated")), patch.object(custom_fields, "read_body", side_effect=AssertionError("parsed")):
            rows, _ = self.service.state_rows()
            self.assertNotIn("fields", rows[0])
            self.service.state_json()
        self.assertEqual(self.service.field_cache, {})
        self.assertEqual(list(self.service.field_dirty), ["a"])

    def test_worker_results_reach_rows_and_bump_revision(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        revision = self.service.revision
        self.assertTrue(custom_fields.drain(self.service, budget=1e9))
        self.assertEqual(self.service.field_dirty, {})
        self.service.changed()
        self.assertGreater(self.service.revision, revision)
        self.assertEqual(self.service.state_rows()[0][0]["fields"][0]["values"], ["7"])
        self.service.save(capture("a"))
        self.assertFalse(custom_fields.drain(self.service, budget=1e9))

    def test_old_results_stay_until_replaced(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        self.rows()
        changed = capture("a")
        changed["response"]["body"] = '{"id":8}'
        self.service.save(changed)
        self.assertEqual(self.service.state_rows()[0][0]["fields"][0]["values"], ["7"])
        self.assertTrue(custom_fields.drain(self.service, budget=1e9))
        self.assertEqual(self.service.state_rows()[0][0]["fields"][0]["values"], ["8"])

    def test_config_change_reevaluates_every_capture(self):
        self.use(field("id", "$.id"))
        for n in range(3):
            self.service.save(capture(f"r{n}", startedAt=100.0 + n))
        self.rows()
        self.use(field("name", "$.name"))
        self.assertEqual((self.service.field_cache, set(self.service.field_dirty)), ({}, {"r0", "r1", "r2"}))
        self.assertTrue(all("fields" not in row for row in self.service.state_rows()[0]))
        calls, patched = self.counting()
        with patched:
            rows = self.rows()
        self.assertEqual(sorted(calls), ["r0", "r1", "r2"])
        self.assertTrue(all(row["fields"][0]["id"] == "name" for row in rows.values()))

    def test_repeated_saves_coalesce(self):
        self.use(field("id", "$.id"))
        for _ in range(5):
            self.service.save(capture("a"))
        self.assertEqual(list(self.service.field_dirty), ["a"])
        calls, patched = self.counting()
        with patched:
            custom_fields.drain(self.service, budget=1e9)
        self.assertEqual(calls, ["a"])

    def test_newest_first_in_time_slices(self):
        self.use(field("id", "$.id"))
        for n in (2, 0, 3, 1):
            self.service.save(capture(f"r{n}", startedAt=100.0 + n))
        calls, patched = self.counting()
        with patched:
            custom_fields.drain(self.service, budget=0)
            self.assertEqual((calls, list(self.service.field_dirty)), (["r3"], ["r2", "r0", "r1"]))
            custom_fields.drain(self.service, budget=1e9)
        self.assertEqual(calls, ["r3", "r2", "r1", "r0"])

    def test_missing_and_unmatched_records_are_skipped(self):
        self.use(field("id", "$.id", pattern="https://nowhere.test/*"))
        self.service.save(capture("a"))
        self.service.field_dirty["ghost"] = None
        self.assertFalse(custom_fields.drain(self.service, budget=1e9))
        self.assertEqual(self.service.field_dirty, {})
        self.assertNotIn("fields", self.service.state_rows()[0][0])

    def test_nothing_is_queued_without_fields(self):
        self.service.save(capture("a"))
        self.assertEqual(self.service.field_dirty, {})

    def test_forget_and_discard_remove_queued_ids(self):
        self.use(field("id", "$.id"))
        self.service.save(capture("a"))
        self.service.save(capture("b"))
        self.service.forget_record("a")
        self.assertEqual(list(self.service.field_dirty), ["b"])
        self.service.discard_captures()
        self.assertEqual(self.service.field_dirty, {})

    def test_restart_queues_loaded_captures(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, "test-token", 47821)
            try:
                service.productivity = validate(config(field("id", "$.id")))
                service.persist_config()
                service.save(capture("a"))
            finally:
                service.db.close()
            restored = Service(directory, "test-token", 47821)
            try:
                self.assertEqual(list(restored.field_dirty), ["a"])
                self.assertNotIn("fields", restored.state_rows()[0][0])
            finally:
                restored.db.close()


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "test-token", 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={"Authorization": "Bearer test-token", "Host": "127.0.0.1:47821"})
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def settle(self):
        """Run the real worker until the queue is empty and its last throttled change has been published."""
        task = asyncio.create_task(custom_fields.worker(self.service, interval=.01))
        try:
            while self.service.field_dirty:
                await asyncio.sleep(.005)
            await asyncio.sleep(.04)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_put_rebuilds_rows_and_analysis_exposes_fields(self):
        self.service.save(capture())
        first = await (await self.client.get("/api/state")).json()
        self.assertNotIn("fields", first["records"][0])
        current = await (await self.client.get("/api/productivity")).json()
        revision = self.service.revision
        response = await self.client.put("/api/productivity", json={"revision": current["revision"], "config": config(field("id", "$.id"))})
        self.assertEqual(response.status, 200)
        self.assertGreater(self.service.revision, revision)
        self.assertNotIn("fields", (await (await self.client.get("/api/state")).json())["records"][0])
        self.assertEqual(list(self.service.field_dirty), ["capture"])
        revision = self.service.revision
        await self.settle()
        self.assertGreater(self.service.revision, revision)
        since = f"{first['instance']}:{first['revision']}"
        delta = await (await self.client.get(f"/api/state?since={since}")).json()
        self.assertTrue(delta["delta"])
        self.assertEqual(delta["rows"][0]["fields"][0]["values"], ["7"])
        self.assertEqual(delta["productivity"]["fields"], 1)
        analysis = await (await self.client.get("/api/analysis?recordId=capture")).json()
        self.assertEqual(analysis["rows"][0]["fields"], delta["rows"][0]["fields"])
        self.assertNotIn("watches", analysis["rows"][0])
        bad = await self.client.put("/api/productivity", json={"revision": current["revision"] + 1, "config": config(field("id", "Bad Header", source="responseHeader"))})
        self.assertEqual(bad.status, 400)
        legacy = {key: value for key, value in copy.deepcopy(DEFAULT).items() if key != "fields"}
        legacy["watches"] = [{"id": "w", "name": "W", "source": "response", "path": "$.name"}]
        migrated = await self.client.put("/api/productivity", json={"revision": current["revision"] + 1, "config": legacy})
        self.assertEqual((await migrated.json())["config"]["fields"][0]["locations"][0]["pattern"], "*")
        await self.settle()
        row = (await (await self.client.get("/api/state")).json())["records"][0]
        self.assertEqual(row["fields"][0]["values"], ["Ann"])

    async def test_changed_is_throttled(self):
        self.service.productivity = validate(config(field("id", "$.id")))
        for n in range(200):
            self.service.save(capture(f"r{n}", startedAt=100.0 + n))
        calls, published = [], self.service.changed
        self.service.changed = lambda: (calls.append(1), published())
        start = asyncio.get_running_loop().time()
        task = asyncio.create_task(custom_fields.worker(self.service, budget=0, interval=.05))
        try:
            while self.service.field_dirty:
                await asyncio.sleep(0)
            await asyncio.sleep(.12)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        elapsed = asyncio.get_running_loop().time() - start
        self.assertEqual(len(self.service.field_cache), 200)
        self.assertGreaterEqual(len(calls), 1)
        self.assertLessEqual(len(calls), elapsed / .05 + 1)
        self.assertTrue(all("fields" in row for row in self.service.state_rows()[0]))

    async def test_fields_route_returns_full_values_and_404s(self):
        big = {"items": [{"n": n, "label": "x" * 20} for n in range(40)]}
        record = capture()
        record["response"]["body"] = json.dumps({"id": 7, "big": big})
        self.service.save(record)
        current = await (await self.client.get("/api/productivity")).json()
        await self.client.put("/api/productivity", json={"revision": current["revision"], "config": config(field("big", "$.big"), field("id", "$.id"))})
        response = await self.client.get("/api/records/capture/fields")
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual((body["id"], body["rev"]), ("capture", self.service.record_revs.get("capture", 0)))
        self.assertEqual([item["id"] for item in body["fields"]], ["big", "id"])
        self.assertEqual(json.loads(body["fields"][0]["values"][0]), big)
        self.assertEqual(body["fields"][0]["summaries"], ["{1 key}"])
        await self.settle()
        row = (await (await self.client.get("/api/state")).json())["records"][0]
        self.assertEqual((len(row["fields"][0]["values"][0]), row["fields"][0]["limited"]), (256, True))
        self.assertEqual((await self.client.get("/api/records/missing/fields")).status, 404)
        anonymous = TestClient(TestServer(create_app(self.service)), headers={"Host": "127.0.0.1:47821"})
        await anonymous.start_server()
        try:
            self.assertEqual((await anonymous.get("/api/records/capture/fields")).status, 401)
        finally:
            await anonymous.close()

    async def test_productivity_put_clears_full_cache(self):
        self.service.save(capture())
        current = await (await self.client.get("/api/productivity")).json()
        await self.client.put("/api/productivity", json={"revision": current["revision"], "config": config(field("id", "$.id"))})
        await self.client.get("/api/records/capture/fields")
        self.assertEqual(list(self.service.field_full_cache), ["capture"])
        await self.client.put("/api/productivity", json={"revision": current["revision"] + 1, "config": config(field("name", "$.name"))})
        self.assertEqual(self.service.field_full_cache, {})
        body = await (await self.client.get("/api/records/capture/fields")).json()
        self.assertEqual(body["fields"][0]["values"], ["Ann"])

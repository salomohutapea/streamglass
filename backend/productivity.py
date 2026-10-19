"""Read-only capture analysis and validated daily-work preferences."""
import asyncio
import copy
import fnmatch
import json
import re
import time
from itertools import islice

from aiohttp import web

DEFAULT = {"journey": {"paths": ["$.context.searchId", "$.searchId", "$.data.searchId"],
                       "headers": ["x-request-id", "x-correlation-id"], "inventoryPath": ""},
           "watches": [], "assertions": [], "views": []}
COLORS = ("", "blue", "green", "amber", "red", "purple")
MAX_ANALYSIS = 4 * 1024 * 1024


def path_tokens(path):
    if not isinstance(path, str) or len(path) > 512 or not path.startswith("$"):
        raise ValueError("JSONPath must start with $ and contain at most 512 characters")
    tokens, pos = [], 1
    while pos < len(path):
        match = re.match(r"\.([A-Za-z_$][\w$-]*|\*)|\[(\d+|\*|\"(?:[^\"\\]|\\.)*\"|'[^']*')\]", path[pos:])
        if not match:
            raise ValueError("Use JSONPath fields, quoted keys, array indexes, and [*]; filters and recursive descent are unsupported")
        field, bracket = match.groups()
        if field is not None:
            token = field
        elif bracket.isdecimal():
            token = int(bracket)
        elif bracket.startswith('"'):
            token = json.loads(bracket)
        elif bracket.startswith("'"):
            token = bracket[1:-1]
        else:
            token = "*"
        # A quoted * is a literal property, not a wildcard.
        tokens.append(("wildcard" if (field == "*" or bracket == "*") else "key", token))
        if len(tokens) > 32:
            raise ValueError("JSONPath has more than 32 steps")
        pos += match.end()
    return tokens


def select(value, path):
    values = [value]
    for kind, key in path_tokens(path):
        result = []
        for item in values:
            if kind == "wildcard":
                result.extend(islice(item.values() if isinstance(item, dict) else item if isinstance(item, list) else [], 10001 - len(result)))
            elif isinstance(item, dict) and isinstance(key, str) and key in item:
                result.append(item[key])
            elif isinstance(item, list) and isinstance(key, int) and key < len(item):
                result.append(item[key])
            if len(result) > 10000:
                raise ValueError("JSONPath expands to more than 10,000 values")
        values = result
    return values


def text(value, name, maximum=256, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError(f"Invalid {name}")
    return value


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT):
        raise ValueError("Expected journey, watches, assertions, and views")
    value = copy.deepcopy(value)
    journey = value["journey"]
    if not isinstance(journey, dict) or set(journey) != {"paths", "headers", "inventoryPath"}:
        raise ValueError("Invalid journey configuration")
    if not isinstance(journey["paths"], list) or len(journey["paths"]) > 10:
        raise ValueError("Use at most 10 journey JSONPaths")
    for path in journey["paths"]:
        path_tokens(path)
    if not isinstance(journey["headers"], list) or len(journey["headers"]) > 10:
        raise ValueError("Use at most 10 correlation headers")
    for name in journey["headers"]:
        if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", name):
            raise ValueError("Invalid journey header")
    if journey["inventoryPath"]:
        path_tokens(journey["inventoryPath"])
    elif journey["inventoryPath"] != "":
        raise ValueError("Invalid inventory JSONPath")
    for key in ("watches", "assertions", "views"):
        items = value[key]
        if not isinstance(items, list) or len(items) > 50:
            raise ValueError(f"Expected at most 50 {key}")
        ids = set()
        for item in items:
            if not isinstance(item, dict):
                raise ValueError(f"Invalid {key} entry")
            text(item.get("id"), "id", 128)
            text(item.get("name"), "name", 100)
            if item["id"] in ids:
                raise ValueError("IDs must be unique")
            ids.add(item["id"])
            allowed = {"id", "name", "path", "source"} if key == "watches" else {"id", "name", "enabled", "pattern", "method", "kind", "path", "source", "eventName", "timeoutMs"} if key == "assertions" else {"id", "name", "filter", "scope", "mode", "protocols", "statuses", "device", "application", "library"}
            if set(item) != allowed:
                raise ValueError(f"Unexpected {key} fields")
            if key in ("watches", "assertions"):
                if item["source"] not in ("request", "response", "event"):
                    raise ValueError("Invalid content source")
                if key == "watches" or item["kind"] == "required-field":
                    path_tokens(item["path"])
                else:
                    text(item["path"], "path", 512, True)
            if key == "assertions":
                if type(item["enabled"]) is not bool or item["kind"] not in ("first-data", "required-field", "duplicate-event-id", "terminal-event"):
                    raise ValueError("Invalid assertion")
                text(item["pattern"], "URL wildcard", 4096)
                text(item["method"], "method", 64)
                text(item["eventName"], "event name", 128, True)
                if item["kind"] in ("first-data", "terminal-event") and not item["eventName"]:
                    raise ValueError("This assertion needs an event name")
                if type(item["timeoutMs"]) is not int or not 1 <= item["timeoutMs"] <= 3600000:
                    raise ValueError("Assertion timeout must be 1..3,600,000 ms")
            if key == "views":
                text(item["filter"], "filter", 1024, True)
                text(item["device"], "device", 256)
                if item["application"] is not None:
                    text(item["application"], "application", 1024)
                if item["scope"] not in ("url", "request", "response", "event") or item["mode"] not in ("contains", "not_contains", "equals", "starts_with", "ends_with", "wildcard") or item["library"] not in ("all", "sse", "pinned"):
                    raise ValueError("Invalid saved search")
                if not isinstance(item["protocols"], list) or len(item["protocols"]) > 3 or any(p not in ("HTTP", "HTTPS", "SSE") for p in item["protocols"]):
                    raise ValueError("Invalid protocol filters")
                if not isinstance(item["statuses"], list) or len(item["statuses"]) > 5 or any(type(s) is not int or s not in range(1, 6) for s in item["statuses"]):
                    raise ValueError("Invalid status filters")
    return value


def annotation(value):
    if not isinstance(value, dict) or set(value) != {"note", "color"} or value["color"] not in COLORS:
        raise ValueError("Expected note and a supported highlight color")
    text(value["note"], "note", 8000, True)
    return value.copy()


def documents(record):
    remaining = MAX_ANALYSIS
    result = {"request": [], "response": [], "event": []}
    warnings = []
    missing = object()
    def parse(body, source):
        nonlocal remaining
        if not isinstance(body, str) or not body:
            return missing
        # UTF-8 costs at least one byte per character; avoid encoding an enormous preview.
        if len(body) > remaining or len(body.encode()) > remaining:
            warnings.append("Analysis reached its 4 MiB JSON budget; some values are unknown.")
            return missing
        remaining -= len(body.encode())
        try:
            parsed = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
        except (ValueError, RecursionError):
            warnings.append(f"{source} body is not supported JSON.")
            return missing
        return parsed
    for source in ("request", "response"):
        message = record.get(source) or {}
        if message.get("bodyUnavailable"):
            warnings.append(f"{source} body was not fully retained.")
            continue
        body = parse(message.get("body"), source)
        if body is not missing:
            result[source].append((body, record.get("startedAt")))
    events = record.get("events", [])
    if record.get("captureWarning") or len(events) < record.get("eventCount", 0) or len(events) > 1000:
        warnings.append("SSE analysis does not include all observed events.")
    for event in events[:1000]:
        body = parse(event.get("data"), "event")
        if body is not missing:
            result["event"].append((body, event.get("processedAt", event.get("receivedAt"))))
    return result, list(dict.fromkeys(warnings))


def facts(record, config):
    docs, warnings = documents(record)
    def values(source, path):
        try:
            return [item for body, _ in docs[source] for item in select(body, path)]
        except ValueError as exc:
            warnings.append(str(exc))
            return []
    correlations = set()
    for source in docs:
        for path in config["journey"]["paths"]:
            for value in values(source, path):
                if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value) and len(str(value)) <= 256:
                    correlations.add(str(value))
    for source in ("request", "response"):
        for name, value in (record.get(source) or {}).get("headers", []):
            if name.lower() in [h.lower() for h in config["journey"]["headers"]] and value and len(value) <= 256:
                correlations.add(value)
    watches = []
    preview_budget = 32768
    for watch in config["watches"]:
        found = values(watch["source"], watch["path"])
        previews, limited, preview_error = [], len(found) > 10, False
        for item in found[:10]:
            try:
                encoded = json.dumps(item, ensure_ascii=False, allow_nan=False)
            except (ValueError, RecursionError):
                warnings.append("A watch value exceeds supported JSON nesting or numeric limits.")
                preview_error, limited = True, True
                break
            size = min(1024, preview_budget)
            limited |= len(encoded) > size
            if size:
                previews.append(encoded[:size])
                preview_budget -= len(previews[-1])
        watches.append({"id": watch["id"], "name": watch["name"], "values": previews, "count": len(found), "limited": limited, "unknown": preview_error or not found and bool(warnings)})
    first_inventory = None
    path = config["journey"]["inventoryPath"]
    if path:
        for body, at in docs["event"]:
            try:
                if any(bool(item) for item in select(body, path)):
                    first_inventory = at
                    break
            except ValueError as exc:
                warnings.append(str(exc))
                break
    required = {}
    for rule in config["assertions"]:
        if rule["kind"] == "required-field":
            required[rule["id"]] = bool(values(rule["source"], rule["path"]))
    return {"correlations": sorted(correlations)[:50], "watches": watches, "firstInventoryAt": first_inventory,
            "firstDataAt": next((event.get("processedAt", event.get("receivedAt")) for event in record.get("events", [])[:1000] if event.get("event") == "data" and event.get("forwarded", True)), None),
            "required": required, "warnings": list(dict.fromkeys(warnings))}


def assertions(record, config, fact, now):
    output = []
    complete = record.get("state") in ("complete", "error", "interrupted")
    events = record.get("events", [])[:1000]
    is_sse = bool(record.get("isSSE") or record.get("sseDiagnostics"))
    history_gap = bool(record.get("captureWarning")) or len(record.get("events", [])) < record.get("eventCount", 0) or len(record.get("events", [])) > 1000
    for rule in config["assertions"]:
        if not rule["enabled"] or rule["method"].upper() not in ("*", record["method"].upper()) or not fnmatch.fnmatchcase(record["url"], rule["pattern"]):
            continue
        kind = rule["kind"]
        if kind != "required-field" and not is_sse:
            continue
        result, message = "pending", "Waiting for matching content"
        if kind == "required-field":
            if fact["required"].get(rule["id"]):
                result, message = "pass", "Field exists"
            elif fact["warnings"]:
                result, message = "unknown", "Complete JSON content is unavailable"
            elif complete or rule["source"] == "request":
                result, message = "fail", "Required field is missing"
        elif kind == "duplicate-event-id":
            ids = [event["id"] for event in events if event.get("id")]
            duplicate = next((item for index, item in enumerate(ids) if item in ids[:index]), None)
            if duplicate:
                result, message = "fail", "Repeated explicit event ID: " + duplicate[:128]
            elif history_gap:
                result, message = "unknown", "Event history is incomplete"
            elif complete:
                result, message = "pass", "No repeated explicit event IDs"
        else:
            found = next((event for event in events if event.get("event") == rule["eventName"] and event.get("forwarded", True)), None)
            start = (record.get("sseDiagnostics") or {}).get("headersAt") or record["startedAt"]
            if found:
                at = found.get("processedAt")
                if kind == "first-data" and (at is None or found.get("timingDeferred")):
                    result, message = "unknown", "Post-rule event timing is unavailable or transport scheduling is deferred"
                else:
                    elapsed = max(0, ((at or start) - start) * 1000)
                    late = kind == "first-data" and elapsed > rule["timeoutMs"]
                    if late and history_gap:
                        result, message = "unknown", "Earlier event history is incomplete"
                    else:
                        result, message = ("fail", f"First {rule['eventName']} processed after {elapsed:.0f} ms") if late else ("pass", f"Observed {rule['eventName']}")
            elif history_gap:
                result, message = "unknown", "Event history is incomplete"
            elif complete or (kind == "first-data" and (now - start) * 1000 >= rule["timeoutMs"]):
                result, message = "fail", f"No {rule['eventName']} event" + (f" within {rule['timeoutMs']} ms" if kind == "first-data" else " before the stream ended")
        output.append({"id": rule["id"], "name": rule["name"], "result": result, "message": message})
    return output


def analyze(service, record, now=None):
    cached = service.analysis_cache.get(record["id"])
    if cached is None:
        cached = facts(record, service.productivity)
        service.analysis_cache[record["id"]] = cached
    return {"id": record["id"], **{key: value for key, value in cached.items() if key != "required"},
            "assertions": assertions(record, service.productivity, cached, time.time() if now is None else now)}


async def monitor(service):
    while True:
        for record_id in list(service.analysis_cache):
            if record_id not in service.records:
                service.analysis_cache.pop(record_id, None)
        active = any(rule["enabled"] for rule in service.productivity["assertions"])
        summaries = {}
        if active:
            for record in list(service.records.values()):
                result = analyze(service, record)
                counts = {name: 0 for name in ("pass", "fail", "pending", "unknown")}
                for check in result["assertions"]:
                    counts[check["result"]] += 1
                if any(counts.values()):
                    summaries[record["id"]] = counts
                await asyncio.sleep(.005)
        if summaries != service.assertion_summaries:
            service.assertion_summaries = summaries
            service.changed()
        await asyncio.sleep(1)


def install(app, service):
    async def preferences(request):
        if request.method == "PUT":
            value = await request.json()
            if not isinstance(value, dict) or set(value) != {"revision", "config"} or type(value["revision"]) is not int:
                raise ValueError("Expected configuration and revision")
            if value["revision"] != service.productivity_revision:
                raise web.HTTPConflict(reason="Tools changed elsewhere. Reload before saving.")
            checked = validate(value["config"])
            previous = service.productivity
            service.productivity = checked
            try:
                service.persist_config()
            except Exception:
                service.productivity = previous
                raise
            service.analysis_cache.clear()
            service.productivity_revision += 1
        return web.json_response({"revision": service.productivity_revision, "config": service.productivity})

    async def analyze_records(request):
        start, size = int(request.query.get("offset", "0")), int(request.query.get("limit", "50"))
        if start < 0 or not 1 <= size <= 100:
            raise ValueError("Invalid analysis page")
        records = sorted(service.records.values(), key=lambda item: item["startedAt"], reverse=True)
        if record_id := request.query.get("recordId"):
            records = [r for r in records if r["id"] == record_id]
        rows = []
        for record in records[start:start + size]:
            rows.append(analyze(service, record))
            await asyncio.sleep(0)
        return web.json_response({"rows": rows, "total": len(records), "offset": start, "nextOffset": start + size if start + size < len(records) else None})

    async def annotate(request):
        checked = annotation(await request.json())
        record = service.records.get(request.match_info["id"])
        if record is None:
            raise web.HTTPNotFound()
        previous = record.get("annotation")
        record["annotation"] = checked
        try:
            service.save(record)
        except Exception:
            if previous is None:
                record.pop("annotation", None)
            else:
                record["annotation"] = previous
            raise
        return web.json_response(checked)

    app.add_routes([web.get("/api/productivity", preferences), web.put("/api/productivity", preferences),
                    web.get("/api/analysis", analyze_records), web.patch("/api/records/{id}/annotation", annotate)])

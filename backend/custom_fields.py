"""Custom fields: values of specific APIs highlighted in the table and inspector.

Results are cached per capture. A body is parsed again only when its string object changes, and SSE events are
read incrementally past a cursor, so a stream that receives thousands of events costs only the new ones."""
import asyncio
import fnmatch
import json
import time
from functools import lru_cache

from .productivity import MAX_ANALYSIS, path_tokens, select_tokens

MAX_VALUES = 5
MAX_TEXT = 256
MAX_FULL_TEXT = 64 * 1024
FULL_CACHE = 4
MAX_EVENTS = 20000
# Events are parsed once each, so a whole retained stream (32 MiB) fits; one event still has the 4 MiB body cap.
EVENT_BUDGET = 32 * 1024 * 1024
FINISHED = ("complete", "error", "interrupted")
PENDING_SOURCES = ("response", "event", "responseHeader")
ENCODER = json.JSONEncoder(ensure_ascii=False, allow_nan=False)
tokens = lru_cache(maxsize=256)(path_tokens)


def reject(_):
    raise ValueError("Nonfinite JSON")


def new():
    return {"values": [], "summaries": [], "seen": set(), "limited": False, "note": None}


def summarize(value):
    """Short size label for containers; None for scalars."""
    if isinstance(value, list):
        return f"[{len(value)} item{'' if len(value) == 1 else 's'}]"
    if isinstance(value, dict):
        return f"{{{len(value)} key{'' if len(value) == 1 else 's'}}}"
    return None


def render(value, limit=MAX_TEXT):
    """Display text and whether it was cut at `limit`: strings are raw, everything else is compact JSON."""
    if isinstance(value, str):
        return value[:limit], len(value) > limit
    if value is None or isinstance(value, (bool, int, float)):
        text = json.dumps(value, allow_nan=False)
        return text[:limit], len(text) > limit
    parts, size = [], 0
    for part in ENCODER.iterencode(value):
        parts.append(part)
        size += len(part)
        if size > limit:
            break
    text = "".join(parts)
    return text[:limit], len(text) > limit


def full(acc):
    return len(acc["seen"]) > MAX_VALUES


def add(acc, value, limit=MAX_TEXT):
    try:
        shown, cut = render(value, limit)
    except (ValueError, RecursionError):
        acc["limited"], acc["note"] = True, "A value exceeds supported JSON nesting or numeric limits"
        return
    acc["limited"] |= cut
    if shown in acc["seen"]:
        return
    if full(acc):
        acc["limited"] = True
        return
    acc["seen"].add(shown)
    if len(acc["values"]) < MAX_VALUES:
        acc["values"].append(shown)
        acc["summaries"].append(summarize(value))
    else:
        acc["limited"] = True


def collect(acc, document, path, limit=MAX_TEXT):
    try:
        found = select_tokens(document, tokens(path))
    except ValueError as exc:
        acc["limited"], acc["note"] = True, str(exc)
        return
    for value in found:
        add(acc, value, limit)
        if full(acc):
            break


def too_big(text):
    return len(text) > MAX_ANALYSIS or (len(text) * 4 > MAX_ANALYSIS and len(text.encode()) > MAX_ANALYSIS)


def read_body(side, body, unavailable, paths, indexes, limit=MAX_TEXT):
    accs = {index: new() for index in indexes}
    note = document = None
    if unavailable:
        note = "Body was not fully retained"
    elif not isinstance(body, str) or not body:
        return accs
    elif too_big(body):
        note = "Body exceeds the 4 MiB field budget"
    else:
        try:
            document = json.loads(body, parse_constant=reject)
        except (ValueError, RecursionError):
            note = f"{side.capitalize()} body is not JSON"
    for index, acc in accs.items():
        if note:
            acc["note"] = note
        else:
            collect(acc, document, paths[index], limit)
    return accs


def read_events(state, events, paths, indexes, limit=MAX_TEXT):
    """Process events past the cursor; a field that already has more than five distinct values is left alone."""
    live = [index for index in indexes if not full(state["acc"][index])]
    position = state["cursor"]
    while position < len(events) and live and not state["stopped"]:
        if position >= MAX_EVENTS or state["budget"] <= 0:
            state["stopped"] = True
            for index in live:
                state["acc"][index]["limited"], state["acc"][index]["note"] = True, "SSE event scan limit reached"
            break
        data = events[position].get("data")
        position += 1
        if not isinstance(data, str) or not data:
            continue
        state["budget"] -= len(data)
        if len(data) > MAX_ANALYSIS:
            for index in live:
                state["acc"][index]["limited"], state["acc"][index]["note"] = True, "Body exceeds the 4 MiB field budget"
            continue
        try:
            document = json.loads(data, parse_constant=reject)
        except (ValueError, RecursionError):
            continue
        for index in live:
            collect(state["acc"][index], document, paths[index], limit)
        live = [index for index in live if not full(state["acc"][index])]
    state["cursor"] = len(events) if not live or state["stopped"] else position


def headers_for(message, name, limit=MAX_TEXT):
    acc, name = new(), name.lower()
    for pair in (message or {}).get("headers") or []:
        if isinstance(pair, (list, tuple)) and len(pair) > 1 and str(pair[0]).lower() == name:
            add(acc, str(pair[1]), limit)
    return acc


def merge(accs):
    """One accumulator for a field read from several locations: distinct values in location order, same caps."""
    if len(accs) == 1:
        return accs[0]
    out, shown = new(), set()
    for acc in accs:
        out["limited"] |= acc["limited"]
        out["note"] = out["note"] or acc["note"]
        out["seen"] |= acc["seen"]
        for value, summary in zip(acc["values"], acc["summaries"]):
            if value not in shown and len(out["values"]) < MAX_VALUES:
                shown.add(value)
                out["values"].append(value)
                out["summaries"].append(summary)
    out["limited"] |= len(out["seen"]) > len(out["values"])
    return out


def evaluate(service, record, full=False):
    """Results for the custom fields matching one capture, in configuration order; [] when none apply.
    A field matches when any of its locations does, and values from all matching locations merge into one list.
    full=True renders values up to 64 KiB for the inspector, from a small LRU cache of its own."""
    fields = service.productivity["fields"]
    if not fields or record.get("kind") == "tunnel":
        return []
    cache, record_id, limit = (service.field_full_cache, record["id"], MAX_FULL_TEXT) if full else (service.field_cache, record["id"], MAX_TEXT)
    rev = service.record_revs.get(record_id, 0)
    entry = cache.get(record_id)
    if full and entry:
        cache[record_id] = cache.pop(record_id)
    if entry and entry["fields"] is fields and entry["rev"] == rev:
        return entry["results"]
    key = (record.get("url") or "", (record.get("method") or "").upper())
    if entry is None or entry["fields"] is not fields or entry["key"] != key:
        # match: (field index, matching location indexes); where: (field, location) -> that location's configuration.
        match, where = [], {}
        for index, field in enumerate(fields):
            hits = [n for n, loc in enumerate(field["locations"]) if loc["method"].upper() in ("*", key[1]) and fnmatch.fnmatchcase(key[0], loc["pattern"])]
            if hits:
                match.append((index, hits))
                where.update({(index, n): field["locations"][n] for n in hits})
        entry = cache[record_id] = {"fields": fields, "key": key, "match": match, "where": where, "bodies": {}, "events": None, "rev": rev, "results": []}
        if full:
            while len(cache) > FULL_CACHE:
                cache.pop(next(iter(cache)))
    entry["rev"] = rev
    match, where = entry["match"], entry["where"]
    if not match:
        return entry["results"]
    paths = {index: loc["path"] for index, loc in where.items()}
    accs = {}
    for side in ("request", "response"):
        message = record.get(side) or {}
        indexes = [index for index, loc in where.items() if loc["source"] == side]
        if indexes:
            body, unavailable = message.get("body"), bool(message.get("bodyUnavailable"))
            cached = entry["bodies"].get(side)
            if cached is None or cached["body"] is not body or cached["unavailable"] != unavailable:
                cached = entry["bodies"][side] = {"body": body, "unavailable": unavailable, "accs": read_body(side, body, unavailable, paths, indexes, limit)}
            accs.update(cached["accs"])
        for index, loc in where.items():
            if loc["source"] == side + "Header":
                accs[index] = headers_for(message, loc["path"], limit)
    events = record.get("events") if isinstance(record.get("events"), list) else []
    indexes = [index for index, loc in where.items() if loc["source"] == "event"]
    if indexes:
        state = entry["events"]
        if state is None or len(events) < state["cursor"]:
            state = entry["events"] = {"cursor": 0, "stopped": False, "budget": EVENT_BUDGET, "acc": {index: new() for index in indexes}}
        read_events(state, events, paths, indexes, limit)
        accs.update(state["acc"])
    finished = record.get("state") in FINISHED
    gap = bool(record.get("captureWarning")) or len(events) < record.get("eventCount", 0)
    results = []
    for index, hits in match:
        field = fields[index]
        locations = [field["locations"][n] for n in hits]
        acc = merge([accs[(index, n)] for n in hits])
        incomplete = gap and any(loc["source"] == "event" and not accs[(index, n)]["values"] for n, loc in zip(hits, locations))
        note = acc["note"] or ("SSE event history is incomplete" if incomplete else None)
        pending = not finished and any(loc["source"] in PENDING_SOURCES for loc in locations)
        state_name = "found" if acc["values"] else "pending" if pending else "unknown" if note else "missing"
        result = {"id": field["id"], "name": field["name"], "locations": [{"source": loc["source"], "path": loc["path"]} for loc in locations], "values": list(acc["values"]), "summaries": list(acc["summaries"]), "count": len(acc["seen"]), "state": state_name, "limited": acc["limited"]}
        if note and not acc["values"]:
            result["note"] = note
        results.append(result)
    entry["results"] = results
    return results


SLICE = .008
INTERVAL = .1


def drain(service, budget=SLICE, clock=time.perf_counter):
    """Evaluate queued captures, newest first, until `budget` seconds have passed (at least one is always done).
    Returns whether any capture's row results changed."""
    records, dirty = service.records, service.field_dirty
    for record_id in [queued for queued in dirty if queued not in records]:
        del dirty[record_id]
    changed, start = False, clock()
    for record_id in sorted(dirty, key=lambda queued: records[queued]["startedAt"], reverse=True):
        del dirty[record_id]
        before = (service.field_cache.get(record_id) or {}).get("results") or []
        changed |= evaluate(service, records[record_id]) != before
        if clock() - start >= budget:
            break
    return changed


async def worker(service, budget=SLICE, interval=INTERVAL):
    """Keep row results fresh off the request path: short slices between awaits, and at most one state change per `interval`."""
    stale, last = False, float("-inf")
    while True:
        if not service.field_dirty and not stale:
            service.field_wake.clear()
            await service.field_wake.wait()
            continue
        if service.field_dirty:
            stale |= drain(service, budget)
        now = time.monotonic()
        if stale and now - last >= interval:
            stale, last = False, now
            service.changed()
        elif stale and not service.field_dirty:
            await asyncio.sleep(last + interval - now)
            continue
        await asyncio.sleep(0)

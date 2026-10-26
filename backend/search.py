"""Search retained text without transferring capture bodies to the UI."""
import asyncio
import fnmatch


def snapshot(records, scope):
    rows = []
    incomplete = False
    for record in records:
        texts = []
        partial = False
        if scope == "url":
            texts.append(record.get("url", ""))
        elif scope == "event":
            for event in record.get("events", []):
                texts.extend(str(event[key]) for key in ("event", "data", "id", "retry") if event.get(key) is not None)
            partial = bool(record.get("captureWarning")) or record.get("eventCount", 0) > len(record.get("events", []))
        else:
            message = record.get(scope) or {}
            texts.extend(str(part) for pair in message.get("headers", []) for part in pair)
            texts.extend(message.get(key, "") for key in ("body", "bodyPreview"))
            if scope == "request" and message:
                texts.extend((record.get("url", ""), record.get("method", "")))
            elif scope == "response" and message:
                texts.append(str(record.get("statusCode") or message.get("statusCode") or ""))
            partial = bool(message.get("bodyUnavailable"))
        incomplete |= partial
        rows.append((record["id"], tuple(text for text in texts if text), partial))
    return rows, incomplete


def match(rows, query, mode):
    def matches(text):
        text = text.casefold()
        if mode in ("contains", "not_contains"):
            return query in text
        if mode == "equals":
            return query == text
        if mode == "starts_with":
            return text.startswith(query)
        if mode == "ends_with":
            return text.endswith(query)
        return fnmatch.fnmatchcase(text, query)
    ids = []
    for record_id, texts, partial in rows:
        if not query:
            ids.append(record_id)
        elif texts:
            found = any(matches(text) for text in texts)
            accepted = not found and not partial if mode == "not_contains" else found
            if accepted:
                ids.append(record_id)
    return ids


def evaluate(records, scope, query, mode):
    rows, incomplete = snapshot(records, scope)
    return {"ids": match(rows, query, mode), "incomplete": incomplete,
            "warning": "Search covers retained text only; some contents were not captured." if incomplete else None}


def evaluate_each(records, scope, query, mode):
    """Per-record (matched, partial) results, so a later search only re-checks records that changed."""
    rows, _ = snapshot(records, scope)
    matched = set(match(rows, query, mode))
    return {record_id: (record_id in matched, partial) for record_id, _, partial in rows}


def signature(record, rev):
    """What a cached result depends on. Messages are replaced rather than edited and events are appended, so object
    identity plus the event count detects changes even when a caller bumps the revision without saving."""
    return (rev, record.get("url"), record.get("request"), record.get("response"), len(record.get("events") or ()), record.get("captureWarning"))


def unchanged(cached, current):
    return cached is not None and len(cached) == len(current) and all(a is b or a == b for a, b in zip(cached, current))


async def search(service, scope, query, mode="contains"):
    if scope not in ("url", "request", "response", "event"):
        raise ValueError("scope must be url, request, response, or event")
    if mode not in ("contains", "not_contains", "equals", "starts_with", "ends_with", "wildcard"):
        raise ValueError("Invalid search mode")
    if len(query) > 1024:
        raise ValueError("Search query exceeds 1024 characters")
    # One worker and one cached result bound repeated polling during active streams. Results are kept per record and
    # keyed by its save revision, so polling during traffic re-checks only the captures that changed.
    async with service.search_lock:
        key = (scope, query.casefold(), mode)
        cache = service.search_cache if service.search_cache and service.search_cache["key"] == key else {"key": key, "revision": None, "results": {}, "result": None}
        if cache["revision"] == service.revision:
            return cache["result"]
        revision, revs = service.revision, service.record_revs
        signatures = {record_id: signature(record, revs.get(record_id, 0)) for record_id, record in service.records.items()}
        stale = [record for record_id, record in service.records.items() if not unchanged(cache["results"].get(record_id, (None,))[0], signatures[record_id])]
        # Messages/event objects are replaced, not edited, after retention; copy the growing event lists.
        copies = tuple({**record, "events": tuple(record.get("events", ())) if scope == "event" else ()} for record in stale)
        fresh = await asyncio.to_thread(evaluate_each, copies, scope, key[1], mode) if copies else {}
        results = {record_id: cache["results"][record_id] for record_id in service.records if record_id in cache["results"]}
        for record in stale:
            results[record["id"]] = (signatures[record["id"]], *fresh[record["id"]])
        ids = [record_id for record_id in service.records if record_id in results and results[record_id][1]]
        incomplete = any(partial for _, _, partial in results.values())
        result = {"ids": ids, "incomplete": incomplete,
                  "warning": "Search covers retained text only; some contents were not captured." if incomplete else None}
        service.search_cache = {"key": key, "revision": revision, "results": results, "result": result}
        return result

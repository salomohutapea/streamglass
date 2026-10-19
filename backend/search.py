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


async def search(service, scope, query, mode="contains"):
    if scope not in ("url", "request", "response", "event"):
        raise ValueError("scope must be url, request, response, or event")
    if mode not in ("contains", "not_contains", "equals", "starts_with", "ends_with", "wildcard"):
        raise ValueError("Invalid search mode")
    if len(query) > 1024:
        raise ValueError("Search query exceeds 1024 characters")
    # One worker and one cached result bound repeated polling during active streams.
    async with service.search_lock:
        key = (service.revision, scope, query.casefold(), mode)
        if service.search_cache and service.search_cache[0] == key:
            return service.search_cache[1]
        # Messages/event objects are replaced, not edited, after retention; copy the growing event lists.
        records = tuple({**record, "events": tuple(record.get("events", ())) if scope == "event" else ()}
                        for record in service.records.values())
        result = await asyncio.to_thread(evaluate, records, scope, key[2], mode)
        service.search_cache = (key, result)
        return result

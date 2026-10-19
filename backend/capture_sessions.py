"""Immutable capture archives. Import never replaces live traffic or configuration."""
import asyncio
import json
import math
import time
import uuid

from aiohttp import web

MAX_SESSION = 256 * 1024 * 1024
MAX_STORAGE = 1024 * 1024 * 1024
MAX_RECORD = 32 * 1024 * 1024
MAX_WIRE = MAX_SESSION + 65536
FIELDS = ("id", "url", "method", "statusCode", "device", "startedAt", "endedAt", "durationMs", "state",
          "eventCount", "error", "interruptionReason", "kind", "isEncrypted", "sslInspected", "host", "port", "application", "annotation", "pinned", "isSSE")


def initialize(service):
    service.db.executescript("""
        CREATE TABLE IF NOT EXISTS capture_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_records (session TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session,id));
    """)
    service.archive_readers = set()


def label(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 100:
        raise ValueError("Session name must contain 1..100 characters")
    return value.strip()


def session(service, session_id):
    row = service.db.execute("SELECT id,name,created,count,bytes FROM capture_sessions WHERE id=?", (session_id,)).fetchone()
    if row is None:
        raise web.HTTPNotFound(reason="Saved session not found")
    return dict(zip(("id", "name", "createdAt", "recordCount", "bytes"), row))


def capacity(service, size):
    count, total = service.db.execute("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM capture_sessions").fetchone()
    if count >= 64 or total + size > MAX_STORAGE or size > MAX_SESSION:
        raise ValueError("Saved sessions allow 64 archives, 256 MiB per archive, and 1 GiB total. Export or delete an older session first.")


def validate_record(value):
    from .productivity import annotation
    if not isinstance(value, dict):
        raise ValueError("Invalid capture record")
    for key, maximum in (("id", 128), ("url", 16384), ("method", 64), ("device", 256)):
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > maximum:
            raise ValueError(f"Invalid capture {key}")
    if value.get("kind", "request") not in ("request", "tunnel") or value.get("state") not in ("pending", "streaming", "complete", "error", "interrupted", "paused", "active", "connected"):
        raise ValueError("Invalid capture state or kind")
    for key in ("startedAt", "endedAt", "durationMs"):
        number = value.get(key)
        if key == "startedAt" and number is None or number is not None and (type(number) not in (int, float) or not math.isfinite(number) or number < 0):
            raise ValueError("Invalid capture timing")
    for key in ("pinned", "isEncrypted", "sslInspected", "isSSE", "clientIsLocal"):
        if key in value and type(value[key]) is not bool:
            raise ValueError(f"Invalid capture {key}")
    for key in ("error", "interruptionReason", "host", "captureWarning"):
        if value.get(key) is not None and not isinstance(value[key], str):
            raise ValueError(f"Invalid capture {key}")
    if "annotation" in value:
        annotation(value["annotation"])
    if type(value.get("eventCount", 0)) is not int or value.get("eventCount", 0) < 0:
        raise ValueError("Invalid event count")
    for source in ("request", "response"):
        message = value.get(source)
        if message is None:
            continue
        if not isinstance(message, dict):
            raise ValueError("Invalid capture message")
        headers = message.get("headers", [])
        if not isinstance(headers, list) or len(headers) > 1000 or any(not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(item, str) for item in pair) for pair in headers):
            raise ValueError("Invalid capture headers")
        for key in ("body", "bodyBase64", "url", "method", "bodyUnavailableReason"):
            if key in message and not isinstance(message[key], str):
                raise ValueError("Invalid captured body or request")
        if "bodyUnavailable" in message and type(message["bodyUnavailable"]) is not bool:
            raise ValueError("Invalid retention flag")
        if "statusCode" in message and (type(message["statusCode"]) is not int or not 100 <= message["statusCode"] <= 599):
            raise ValueError("Invalid response status")
    events = value.get("events", [])
    if not isinstance(events, list) or len(events) > 10000:
        raise ValueError("Invalid SSE history")
    for event in events:
        if not isinstance(event, dict) or type(event.get("sequence")) is not int or event["sequence"] < 1:
            raise ValueError("Invalid SSE event")
        for key in ("event", "data", "raw", "rawBase64"):
            if key in event and not isinstance(event[key], str):
                raise ValueError("Invalid SSE event content")
        if event.get("id") is not None and not isinstance(event["id"], str):
            raise ValueError("Invalid SSE event id")
        for key in ("receivedAt", "forwardedAt"):
            if event.get(key) is not None and (type(event[key]) not in (int, float) or not math.isfinite(event[key])):
                raise ValueError("Invalid SSE event time")
    if value.get("sseDiagnostics") is not None and not isinstance(value["sseDiagnostics"], dict):
        raise ValueError("Invalid SSE diagnostics")
    if value.get("logs") is not None and not isinstance(value["logs"], list):
        raise ValueError("Invalid capture logs")
    app = value.get("application")
    if app is not None:
        if not isinstance(app, dict) or not isinstance(app.get("name"), str):
            raise ValueError("Invalid application metadata")
        # Imported icon URLs must not contact an external service while browsing an archive.
        app.pop("icon", None)
    return value


def install(app, service):
    initialize(service)

    async def listing(request):
        if request.method == "POST":
            value = await request.json()
            if not isinstance(value, dict) or set(value) != {"name"}:
                raise ValueError("Expected session name")
            name = label(value["name"])
            count, size = service.db.execute("SELECT COUNT(*),COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM records").fetchone()
            if count == 0 or count > 1000:
                raise ValueError("Save requires 1..1000 retained captures")
            capacity(service, size)
            session_id = str(uuid.uuid4())
            with service.db:
                service.db.execute("INSERT INTO capture_sessions VALUES (?,?,?,?,?)", (session_id, name, time.time(), count, size))
                service.db.execute("INSERT INTO session_records SELECT ?,id,ROW_NUMBER() OVER (ORDER BY started,id),payload FROM records", (session_id,))
            return web.json_response(session(service, session_id), status=201)
        rows = service.db.execute("SELECT id,name,created,count,bytes FROM capture_sessions ORDER BY created DESC").fetchall()
        return web.json_response({"sessions": [dict(zip(("id", "name", "createdAt", "recordCount", "bytes"), row)) for row in rows]})

    async def item(request):
        session_id = request.match_info["session"]
        info = session(service, session_id)
        if request.method == "DELETE":
            if session_id in service.archive_readers:
                raise web.HTTPConflict(reason="This session is being exported. Try deleting it after export finishes.")
            with service.db:
                service.db.execute("DELETE FROM session_records WHERE session=?", (session_id,))
                service.db.execute("DELETE FROM capture_sessions WHERE id=?", (session_id,))
            return web.json_response({"deleted": session_id})
        rows = []
        for (payload,) in service.db.execute("SELECT payload FROM session_records WHERE session=? ORDER BY ordinal", (session_id,)):
            value = json.loads(payload)
            rows.append({key: value.get(key) for key in FIELDS})
        return web.json_response({**info, "records": rows, "readOnly": True})

    async def record(request):
        session(service, request.match_info["session"])
        row = service.db.execute("SELECT payload FROM session_records WHERE session=? AND id=?", (request.match_info["session"], request.match_info["record"])).fetchone()
        if row is None:
            raise web.HTTPNotFound()
        return web.json_response({**json.loads(row[0]), "archiveSnapshot": True})

    async def export(request):
        session_id = request.match_info["session"]
        info = session(service, session_id)
        if session_id in service.archive_readers:
            raise web.HTTPConflict(reason="This session is already being exported")
        service.archive_readers.add(session_id)
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-store"})
        if origin := request.headers.get("Origin"):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        try:
            await response.prepare(request)
            await response.write((json.dumps({"format": "streamglass-session", "version": 2, "name": info["name"], "recordCount": info["recordCount"]}) + "\n").encode())
            for (payload,) in service.db.execute("SELECT payload FROM session_records WHERE session=? ORDER BY ordinal", (session_id,)):
                raw = (payload + "\n").encode()
                for offset in range(0, len(raw), 65536):
                    await response.write(raw[offset:offset + 65536])
            await response.write_eof()
        finally:
            service.archive_readers.discard(session_id)
        return response

    import_lock = asyncio.Lock()

    async def importing(request):
        if import_lock.locked():
            raise web.HTTPConflict(reason="Another session import is in progress")
        async with import_lock:
            pending, total, records, header, ids = bytearray(), 0, [], None, set()
            def line(raw):
                nonlocal header
                if not raw.strip():
                    return
                if len(raw) > MAX_RECORD:
                    raise ValueError("A capture line exceeds the 32 MiB record limit")
                try:
                    value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                except (RecursionError, UnicodeError, ValueError) as exc:
                    raise ValueError("Invalid session JSON") from exc
                if header is None:
                    if not isinstance(value, dict) or value.get("format") != "streamglass-session" or value.get("version") != 2 or type(value.get("recordCount")) is not int or not 1 <= value["recordCount"] <= 1000:
                        raise ValueError("Choose a Streamglass .sgsession archive (version 2)")
                    label(value.get("name"))
                    header = value
                    return
                value = validate_record(value)
                if value["id"] in ids or len(records) >= header["recordCount"]:
                    raise ValueError("Duplicate captures or incorrect archive record count")
                try:
                    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                except (ValueError, RecursionError) as exc:
                    raise ValueError("Unsupported session value or nesting depth") from exc
                if len(payload.encode()) > MAX_RECORD:
                    raise ValueError("Normalized capture exceeds the 32 MiB record limit")
                ids.add(value["id"])
                records.append((value["id"], payload))
            async for chunk in request.content.iter_chunked(65536):
                total += len(chunk)
                if total > MAX_WIRE:
                    raise ValueError("Session import exceeds 256 MiB")
                pending.extend(chunk)
                while (index := pending.find(b"\n")) >= 0:
                    raw = bytes(pending[:index])
                    del pending[:index + 1]
                    line(raw)
                if len(pending) > MAX_RECORD:
                    raise ValueError("A capture line exceeds the 32 MiB record limit")
            if pending:
                line(bytes(pending))
            if header is None or len(records) != header["recordCount"]:
                raise ValueError("Session file ended before all captures arrived")
            size = sum(len(payload.encode()) for _, payload in records)
            capacity(service, size)
            session_id = str(uuid.uuid4())
            with service.db:
                service.db.execute("INSERT INTO capture_sessions VALUES (?,?,?,?,?)", (session_id, label(header["name"]), time.time(), len(records), size))
                service.db.executemany("INSERT INTO session_records VALUES (?,?,?,?)", [(session_id, record_id, index, payload) for index, (record_id, payload) in enumerate(records)])
            return web.json_response(session(service, session_id), status=201)

    app.add_routes([web.get("/api/sessions", listing), web.post("/api/sessions", listing),
                    web.post("/api/sessions/import", importing), web.get("/api/sessions/{session}", item),
                    web.delete("/api/sessions/{session}", item), web.get("/api/sessions/{session}/export", export),
                    web.get("/api/sessions/{session}/records/{record}", record)])

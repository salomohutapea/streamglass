import asyncio
import base64
import copy
import fnmatch
import json
import os
import re
import shlex
import sqlite3
import time
import uuid
import zlib
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from aiohttp import web, ClientSession, ClientTimeout, ClientError

from . import traffic_rules
from .traffic_tools import DEFAULT_NETWORK, summary as traffic_summary, network_for, wait as traffic_wait, map_response
from .timings import compute_timings, GapStats, note_pause
from .sse import SSEParser, EventTooLarge, serialize
from .sse_status import finish as sse_finish, sse_status
from .large_body import before_responseheaders, observe_responsechunk, complete_response

MAX_BODY = 8 * 1024 * 1024
MAX_CAPTURE = 32 * 1024 * 1024
MAX_RECORDS = 1000
SSL_INTERRUPTION_REASON = "Encrypted tunnel interrupted to enable SSL inspection; reconnecting requests will be inspected."


def device_platform(record):
    headers = record.get("request", {}).get("headers", [])
    agent = " ".join(value for name, value in headers if name.lower() == "user-agent").lower()
    if "android" in agent:
        return "android"
    if any(name in agent for name in ("iphone", "ipad", "ipod")):
        return "ios"
    if "macintosh" in agent or "mac os x" in agent:
        return "mac"
    return None


def is_sse(record):
    return bool(record.get("isSSE") or record.get("events") or record.get("eventCount") or any(
        name.lower() == "content-type" and "text/event-stream" in value.lower()
        for name, value in (record.get("response") or {}).get("headers", [])))


def message_value(message, request=False):
    raw = message.raw_content or b""
    from .body_preview import text_preview
    limited = len(raw) > MAX_BODY
    preview = ""
    try:
        if limited:
            body, preview = "", raw[:65536].decode("utf-8", "replace")
        else:
            body, preview, limited = text_preview(message, MAX_BODY)
    except Exception:
        # Invalid or unsupported encodings stay opaque, as they do on the wire.
        body = raw[:MAX_BODY].decode("utf-8", "replace")
    result = {"headers": list(message.headers.items(multi=True)), "body": body,
              "bodyBase64": "" if len(raw) > MAX_BODY else base64.b64encode(raw).decode()}
    if limited:
        result.update(bodyUnavailable=True, bodyPreview=preview,
                      bodyUnavailableReason="Decoded body exceeds the 8 MiB inspection limit; forwarded bytes are unchanged.")
    result.update({"url": message.url, "method": message.method} if request else {"statusCode": message.status_code})
    if message.raw_content is None and message.stream:
        result.update(bodyUnavailable=True, bodyUnavailableReason="Body was streamed; only headers are available.")
    else:
        result.update(body_sizes(message, raw, limited))
    return result


def body_sizes(message, raw, limited=False):
    """Decoded (`size`) and on-the-wire (`encodedSize`) body byte counts; size is None when unknown."""
    from .body_preview import decode_preview
    encoded = len(raw)
    encoding = message.headers.get("content-encoding", "").strip().lower()
    if encoding in ("", "identity"):
        return {"size": encoded, "encodedSize": encoded}
    if limited:
        return {"size": None, "encodedSize": encoded}
    try:
        decoded = len(decode_preview(raw, encoding, MAX_BODY))
    except Exception:
        return {"size": None, "encodedSize": encoded}
    return {"size": decoded if decoded <= MAX_BODY else None, "encodedSize": encoded}


def apply_message(message, value, request=False, headers_only=False):
    from mitmproxy import http
    if not isinstance(value, dict):
        raise ValueError("Edited message must be an object")
    headers = value.get("headers", list(message.headers.items(multi=True)))
    if not isinstance(headers, list) or len(headers) > 1000:
        raise ValueError("headers must be an array of [name,value] pairs")
    checked = []
    for pair in headers:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError("Invalid header pair")
        name, val = map(str, pair)
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or any(c in val for c in "\r\n\x00"):
            raise ValueError("Invalid HTTP header")
        checked.append((name, val))
    new_headers = http.Headers([(key.encode("ascii"), val.encode("latin-1")) for key, val in checked])
    if request:
        method = str(value.get("method", message.method))
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", method):
            raise ValueError("Invalid method")
        url = str(value.get("url", message.url))
        from urllib.parse import urlsplit
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or any(c in url for c in "\r\n\x00"):
            raise ValueError("URL must be an absolute HTTP(S) URL")
    else:
        status = int(value.get("statusCode", message.status_code))
        if not 200 <= status <= 599 and not (status == 101 and message.status_code == 101):
            raise ValueError("Editable status must be 200..599")
    body = None
    if message.raw_content is None and message.stream:
        if value.get("body") or value.get("bodyBase64"):
            raise ValueError("Streamed body is unavailable for editing")
        headers_only = True
    if not headers_only:
        original = message_value(message, request)
        if original.get("bodyUnavailable") and any(value.get(key, original[key]) != original[key] for key in ("body", "bodyBase64")):
            raise ValueError("Body exceeds the inspection limit; only headers and status can be edited")
        if value.get("body", original["body"]) != original["body"]:
            body = str(value["body"]).encode("utf-8")
            new_headers.pop("content-encoding", None)
        elif value.get("bodyBase64", original["bodyBase64"]) != original["bodyBase64"]:
            body = base64.b64decode(value["bodyBase64"], validate=True)
        else:
            body = message.raw_content or b""
        if len(body) > MAX_BODY:
            raise ValueError("Edited body exceeds 8 MiB")
        new_headers.pop("transfer-encoding", None)
        new_headers.pop("content-length", None)
    message.headers = new_headers
    if request:
        message.url, message.method = url, method
    else:
        message.status_code = status
    if body is not None and not (not request and status == 101):
        message.raw_content = b"" if not request and (status in (204, 304)) else body
        if not request and status in (204, 304):
            message.headers.pop("content-length", None)
        else:
            message.headers["content-length"] = str(len(message.raw_content))


class Service:
    def __init__(self, directory, token, port):
        try:
            default_proxy_port = int(os.environ.get("STREAMGLASS_PROXY_PORT", "9090"))
        except ValueError as exc:
            raise ValueError("STREAMGLASS_PROXY_PORT must be a port number") from exc
        if not 1024 <= default_proxy_port <= 65535 or default_proxy_port == port:
            raise ValueError("STREAMGLASS_PROXY_PORT must be 1024..65535 and differ from the management port")
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.token, self.port = token, port
        self.db = sqlite3.connect(self.directory / "captures.sqlite3")
        # Captures are deleted on every start and stop, so a crash may lose the last writes; WAL avoids an fsync per save.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, started REAL, payload TEXT)")
        # SSE events are appended one row each, so a growing stream never rewrites its earlier events.
        self.db.execute("CREATE TABLE IF NOT EXISTS events (record TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(record, seq))")
        config = dict(self.db.execute("SELECT key,value FROM config"))
        self.settings = {"capturePaused": False, "proxyEnabled": True, "proxyPort": default_proxy_port, "listenHost": "0.0.0.0", "tlsDomains": []}
        self.settings.update(json.loads(config.get("settings", "{}")))
        self.rules = json.loads(config.get("rules", "[]"))
        self.rules_revision = int(config.get("rulesRevision", "0"))
        self.scenarios = json.loads(config.get("scenarios", "[]"))
        self.scenario_used = set()
        self.codecs = json.loads(config.get("codecs", "[]"))
        from .productivity import DEFAULT
        self.productivity = json.loads(config.get("productivity", json.dumps(DEFAULT)))
        self.productivity_revision = 0
        self.analysis_cache = {}
        self.assertion_summaries = {}
        self.codec_keys = {}
        self.folders = json.loads(config.get("folders", "[]"))
        self.traffic_tools = traffic_rules.normalize(json.loads(config.get("trafficTools", json.dumps({"mapLocalRules": [], "network": DEFAULT_NETWORK}))))
        self.traffic_tools_revision = int(config.get("trafficToolsRevision", "0"))
        self.records = {row[0]: json.loads(row[1]) for row in self.db.execute("SELECT id,payload FROM records ORDER BY started DESC LIMIT ?", (MAX_RECORDS,))}
        self.record_sizes = dict(self.db.execute("SELECT id,length(CAST(payload AS BLOB)) FROM records"))
        # Persisted event count and bytes per record. Records saved before the events table keep their inline events.
        self.event_rows = {}
        for record_id, count, size in self.db.execute("SELECT record,COUNT(*),SUM(length(CAST(payload AS BLOB))) FROM events GROUP BY record"):
            self.event_rows[record_id] = (count, size)
            self.record_sizes[record_id] = self.record_sizes.get(record_id, 0) + size
            if record_id in self.records:
                self.records[record_id]["events"] = [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM events WHERE record=? ORDER BY seq", (record_id,))]
        self.pending = {}
        self.capture_epoch = 0
        self.capture_pause = asyncio.Event()
        self.flows = {}
        self.streams = {}
        self.tunnels = {}
        self.active_tunnels = {}
        self.tls_failure_counts = {}
        self.tls_ok_devices = set()
        self.tls_established_clients = set()
        self.applications = {}
        self.sockets = set()
        self.master = None
        self.proxy_error = ""
        self.proxy_task = None
        self.dirty = False
        self.http = None
        self.revision = 0
        self.instance = uuid.uuid4().hex[:8]
        # Per-record revision for detail refetches, and the serialized table rows for the current revision.
        self.record_revs = {}
        # Records subject to the count/size limits, rebuilt when the TLS allowlist changes or a record is removed elsewhere.
        self.retention = None
        self.state_rows_cache = None
        self.search_lock = asyncio.Lock()
        self.search_cache = None
        for record in list(self.records.values()):
            if record.get("kind") == "tunnel" and record.get("error") == SSL_INTERRUPTION_REASON:
                record.pop("error")
                record.update(state="interrupted", interruptionReason=SSL_INTERRUPTION_REASON)
                self.save(record)

    def persist_config(self, *, rules=None, folders=None, codecs=None, traffic_tools=None):
        rules = self.rules if rules is None else rules
        folders = self.folders if folders is None else folders
        codecs = self.codecs if codecs is None else codecs
        traffic_tools = self.traffic_tools if traffic_tools is None else traffic_tools
        rules_revision = self.rules_revision + (rules != self.rules)
        traffic_tools_revision = self.traffic_tools_revision + (traffic_tools != self.traffic_tools)
        with self.db:
            for key, value in (("settings", self.settings), ("rules", rules), ("rulesRevision", rules_revision), ("folders", folders), ("trafficTools", traffic_tools), ("trafficToolsRevision", traffic_tools_revision), ("scenarios", self.scenarios), ("codecs", codecs), ("productivity", self.productivity)):
                self.db.execute("INSERT OR REPLACE INTO config VALUES (?,?)", (key, json.dumps(value)))
        self.rules, self.folders, self.codecs, self.traffic_tools = rules, folders, codecs, traffic_tools
        self.rules_revision = rules_revision
        self.traffic_tools_revision = traffic_tools_revision
        self.changed()

    def save(self, record):
        for side, key in (("request", "requestSize"), ("response", "responseSize")):
            message = record.get(side)
            if isinstance(message, dict) and "size" in message:
                record[key] = message["size"]
                record[key + "Encoded"] = message.get("encodedSize")
        self.analysis_cache.pop(record["id"], None)
        if record.get("state") in ("complete", "error", "interrupted") and record.get("endedAt") is None:
            record["endedAt"] = time.time()
            record["durationMs"] = max(0, (record["endedAt"] - record["startedAt"]) * 1000)
        sse_finish(record)
        record_id = record["id"]
        # Events are append-only; only events not yet persisted are serialized. A shorter list rewrites them.
        events = record.get("events") if isinstance(record.get("events"), list) else []
        persisted, event_bytes = self.event_rows.get(record_id, (0, 0))
        rewrite = len(events) < persisted
        if rewrite:
            persisted, event_bytes = 0, 0
        new_events = [json.dumps(event, ensure_ascii=False) for event in events[persisted:]]
        event_bytes += sum(len(item.encode()) for item in new_events)
        payload = json.dumps({**record, "events": []} if "events" in record else record, ensure_ascii=False)
        payload_size = len(payload.encode()) + event_bytes
        if payload_size > MAX_CAPTURE:
            raise ValueError("Capture exceeds 32 MiB storage limit")
        if record.get("pinned"):
            pinned = [r for r in {**self.records, record_id: record}.values() if r.get("pinned")]
            if len(pinned) > MAX_RECORDS or sum(payload_size if r["id"] == record_id else self.record_sizes[r["id"]] for r in pinned) > 256 * 1024 * 1024:
                raise ValueError("Pinned capture storage limit reached; unpin or delete captures")
        retention = self.retention_index()
        self.db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?)", (record_id, record["startedAt"], payload))
        if rewrite:
            self.db.execute("DELETE FROM events WHERE record=?", (record_id,))
        if new_events:
            self.db.executemany("INSERT OR REPLACE INTO events VALUES (?,?,?)", ((record_id, persisted + index, item) for index, item in enumerate(new_events)))
        self.event_rows[record_id] = (len(events), event_bytes)
        self.records[record_id] = record
        if record_id in retention["limited"]:
            retention["size"] -= self.record_sizes.get(record_id, 0)
        self.record_sizes[record_id] = payload_size
        # Captures for TLS-allowlisted domains are never evicted and do not count toward the limits. Pinned captures
        # are never evicted but still count, as before.
        if self.tls_allowlisted(record, retention["patterns"]):
            retention["limited"].discard(record_id)
        else:
            retention["limited"].add(record_id)
            retention["size"] += payload_size
        if len(retention["limited"]) > MAX_RECORDS or retention["size"] > 256 * 1024 * 1024:
            evictable = sorted((self.records[key] for key in retention["limited"] if not self.records[key].get("pinned")), key=lambda r: r["startedAt"])
            for oldest in evictable:
                if len(retention["limited"]) <= MAX_RECORDS and retention["size"] <= 256 * 1024 * 1024:
                    break
                retention["size"] -= self.record_sizes.get(oldest["id"], 0)
                retention["limited"].discard(oldest["id"])
                self.forget_record(oldest["id"])
        self.db.commit()
        self.changed()
        self.record_revs[record_id] = self.revision

    def retention_index(self):
        key = tuple(self.settings["tlsDomains"])
        if self.retention is None or self.retention["key"] != key:
            patterns = [re.compile(pattern, re.IGNORECASE) for pattern in self.tls_patterns()]
            limited = {record_id for record_id, record in self.records.items() if not self.tls_allowlisted(record, patterns)}
            self.retention = {"key": key, "patterns": patterns, "limited": limited, "size": sum(self.record_sizes.get(record_id, 0) for record_id in limited)}
        return self.retention

    def forget_record(self, record_id):
        """Drop one retained capture from memory and storage; the caller commits and calls changed()."""
        self.records.pop(record_id, None)
        self.record_sizes.pop(record_id, None)
        self.event_rows.pop(record_id, None)
        self.analysis_cache.pop(record_id, None)
        self.record_revs.pop(record_id, None)
        if self.retention is not None and record_id in self.retention["limited"]:
            self.retention = None
        self.db.execute("DELETE FROM records WHERE id=?", (record_id,))
        self.db.execute("DELETE FROM events WHERE record=?", (record_id,))

    def tls_allowlisted(self, record, patterns):
        if record.get("sslInspected"):
            return True
        host = urlsplit(record.get("url") or "").netloc or (f"{record.get('host')}:{record.get('port')}" if record.get("host") else "")
        return bool(host) and any(pattern.match(host) for pattern in patterns)

    def discard_captures(self):
        """Delete every retained capture; configuration, rules, and saved capture sessions are left alone."""
        self.db.execute("DELETE FROM records")
        self.db.execute("DELETE FROM events")
        self.db.commit()
        self.db.execute("VACUUM")
        self.records.clear()
        self.record_sizes.clear()
        self.event_rows.clear()
        self.retention = None
        self.analysis_cache.clear()
        self.assertion_summaries.clear()
        self.record_revs.clear()
        self.changed()

    def state_rows(self):
        """Table rows, newest first, plus each application's icon once; rows carry no icon data."""
        keys = ("id", "url", "method", "statusCode", "device", "startedAt", "endedAt", "durationMs", "state", "eventCount", "error", "interruptionReason", "kind", "isEncrypted", "sslInspected", "host", "port", "application", "clientIsLocal", "pinned", "annotation", "tlsFailure")
        records, icons = [], {}
        for r in sorted(self.records.values(), key=lambda r: r["startedAt"], reverse=True):
            row = {**{key: r.get(key) for key in keys}, "pinned": bool(r.get("pinned")), "isSSE": is_sse(r), "serverMs": (r.get("timings") or {}).get("serverMs"), "devicePlatform": device_platform(r), **({"sseStatus": sse_status(r)} if is_sse(r) else {}), "assertionSummary": self.assertion_summaries.get(r["id"]), "rev": self.record_revs.get(r["id"], 0)}
            app = row["application"]
            if isinstance(app, dict) and "icon" in app:
                if app["icon"] and app.get("id"):
                    icons.setdefault(app["id"], app["icon"])
                row["application"] = {key: value for key, value in app.items() if key != "icon"}
            records.append(row)
        return records, icons

    def state_summary(self):
        """Everything in the state snapshot except the rows: small enough to rebuild on every poll."""
        return {"settings": {**self.settings, "proxyRunning": bool(self.master), "proxyError": self.proxy_error}, "rules": self.rules, "rulesRevision": self.rules_revision, "folders": self.folders, "trafficTools": traffic_summary(self.traffic_tools), "trafficToolsRevision": self.traffic_tools_revision, "pending": self.pending_summary(),
                "productivity": {"revision": self.productivity_revision, "watches": len(self.productivity["watches"]), "assertions": sum(r["enabled"] for r in self.productivity["assertions"]),
                                 "replayRunning": any(job["state"] == "running" for job in getattr(self, "replay_jobs", {}).values())}}

    def pending_summary(self):
        return [{key: val for key, val in gate.items() if key not in ("future", "original")} for gate in self.pending.values()]

    def state(self):
        records, icons = self.state_rows()
        return {**self.state_summary(), "records": records, "applicationIcons": icons}

    def state_json(self, since=None):
        """Serialized state and its etag. Rows are serialized once per revision, and each remembers the revision at
        which its text last changed. With `since` ("instance:revision" from an earlier snapshot), only rows changed
        after it are sent, with the full id order so the client can drop removed rows. The etag also covers the small
        summary, which can change without a revision bump (proxy status, gates)."""
        if not self.state_rows_cache or self.state_rows_cache["revision"] != self.revision:
            records, icons = self.state_rows()
            previous = self.state_rows_cache["rows"] if self.state_rows_cache else {}
            rows = {}
            for row in records:
                text = json.dumps(row, separators=(",", ":"))
                old = previous.get(row["id"])
                rows[row["id"]] = (text, old[1] if old and old[0] == text else self.revision)
            icons_json = json.dumps(icons, separators=(",", ":"))
            old_icons = self.state_rows_cache["icons"] if self.state_rows_cache else None
            self.state_rows_cache = {"revision": self.revision, "order": [row["id"] for row in records], "rows": rows,
                                     "icons": (icons_json, old_icons[1] if old_icons and old_icons[0] == icons_json else self.revision)}
        cache = self.state_rows_cache
        summary = json.dumps(self.state_summary(), separators=(",", ":"))
        etag = f"{self.instance}-{self.revision}-{zlib.crc32(summary.encode()):08x}"
        head = f'{summary[:-1]},"etag":"{etag}","instance":"{self.instance}","revision":{self.revision}'
        base = None
        if isinstance(since, str) and since.startswith(self.instance + ":") and since[len(self.instance) + 1:].isdigit():
            base = int(since[len(self.instance) + 1:])
        if base is None or base > self.revision:
            records_json = "[" + ",".join(text for text, _ in (cache["rows"][record_id] for record_id in cache["order"])) + "]"
            return etag, f'{head},"records":{records_json},"applicationIcons":{cache["icons"][0]}}}'
        changed = ",".join(text for text, at in (cache["rows"][record_id] for record_id in cache["order"]) if at > base)
        icons = f',"applicationIcons":{cache["icons"][0]}' if cache["icons"][1] > base else ""
        return etag, f'{head},"delta":true,"rows":[{changed}],"ids":{json.dumps(cache["order"], separators=(",", ":"))}{icons}}}'

    def changed(self):
        self.dirty = True
        self.revision += 1

    async def broadcast(self):
        while True:
            await asyncio.sleep(.15)
            # Nothing subscribes to /api/ws unless a client opts in; skip the snapshot until one does.
            if self.dirty and self.sockets:
                self.dirty = False
                payload = {"type": "state", "data": self.state()}
                for socket in list(self.sockets):
                    try:
                        await asyncio.wait_for(socket.send_json(payload), 1)
                    except (TimeoutError, ConnectionError, RuntimeError):
                        self.sockets.discard(socket)

    def cancel(self, record_id, reason):
        if self.records.get(record_id, {}).get("state") == "interrupted":
            return
        for gate in list(self.pending.values()):
            if gate["recordId"] == record_id and not gate["future"].done():
                gate["future"].set_exception(ConnectionError(reason))
        if record_id in self.records:
            record = self.records[record_id]
            record.update(state="error", error=record.get("error") or reason)
            try:
                self.save(record)
            except (sqlite3.Error, ValueError):
                self.changed()

    def matching_rules(self, flow, stage):
        if self.bypass_rules(flow):
            return []
        return [rule for rule in self.rules if rule.get("enabled", True) and stage in rule.get("stages", []) and (not rule.get("method") or rule["method"] == "*" or rule["method"].upper() == flow.request.method.upper()) and fnmatch.fnmatchcase(flow.request.url, rule.get("pattern", "*"))]
    def bypass_rules(self, flow):
        return self.settings["capturePaused"] or flow.metadata.get("streamglass_passthrough", False)

    def set_capture_paused(self, paused):
        if paused and not self.settings["capturePaused"]:
            self.capture_epoch += 1
            for flow in self.flows.values():
                flow.metadata["streamglass_passthrough"] = True
                if flow.metadata.get("streamglass_map_local") and "streamglass_original_request" in flow.metadata:
                    flow.request = flow.metadata.pop("streamglass_original_request")
            self.capture_pause.set()
            self.capture_pause = asyncio.Event()
            for gate in self.pending.values():
                if not gate["future"].done():
                    gate["future"].set_result(copy.deepcopy(gate["original"]))
        self.settings["capturePaused"] = paused

    async def process(self, flow, stage, value):
        if self.bypass_rules(flow):
            return value
        matches = self.matching_rules(flow, stage)
        if not matches:
            return value
        original = copy.deepcopy(value)
        epoch = self.capture_epoch
        pause = asyncio.create_task(self.capture_pause.wait())
        work = asyncio.create_task(self.process_rules(flow, stage, copy.deepcopy(value), matches, original, epoch))
        try:
            await asyncio.wait((work, pause), return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not work.done():
                work.cancel()
            pause.cancel()
            await asyncio.gather(work, pause, return_exceptions=True)
        if self.bypass_rules(flow) or epoch != self.capture_epoch:
            return original
        return work.result()

    async def process_rules(self, flow, stage, value, matches, original, epoch):
        for rule in matches:
            if self.bypass_rules(flow) or epoch != self.capture_epoch:
                return original
            if rule.get("script"):
                url = os.environ.get("STREAMGLASS_SCRIPT_URL")
                if not url:
                    raise ValueError("JavaScript worker is unavailable")
                hook = {"request": "onRequest", "response": "onResponse", "event": "onEvent"}[stage]
                payload = {"source": rule["script"], "hook": hook, "context": {"flowId": flow.id}, "url": flow.request.url,
                           "request": message_value(flow.request, True)}
                if flow.response:
                    payload["response"] = message_value(flow.response)
                payload[{"request": "request", "response": "response", "event": "event"}[stage]] = value
                async with self.http.post(url.rstrip("/") + "/execute", json=payload, headers={"Authorization": "Bearer " + self.token}) as response:
                    result = await response.json()
                    if self.bypass_rules(flow) or epoch != self.capture_epoch:
                        return original
                    if response.status != 200:
                        raise ValueError("JavaScript hook failed: " + str(result))
                    value = result.get("value", value)
                    if not isinstance(value, dict):
                        raise ValueError("JavaScript hooks must return an object")
                    if flow.id in self.records and result.get("logs"):
                        self.records[flow.id].setdefault("logs", []).extend(result["logs"][:50])
                        self.records[flow.id]["logs"] = self.records[flow.id]["logs"][-200:]
        if self.bypass_rules(flow) or epoch != self.capture_epoch:
            return original
        if any(rule.get("breakpoint") for rule in matches):
            token = str(uuid.uuid4())
            future = asyncio.get_running_loop().create_future()
            self.pending[token] = {"token": token, "recordId": flow.id, "stage": stage, "value": value,
                                   "url": flow.request.url, "method": flow.request.method,
                                   "matchedRules": [rule["id"] for rule in matches], "pausedAt": int(time.time() * 1000), "future": future, "original": original}
            if flow.id in self.records:
                self.records[flow.id]["state"] = "paused"
            self.changed()
            paused_at = time.time()
            try:
                # No timeout: a gate waits until resolved, released by pause, or the flow ends (cancellation).
                value = await future
            finally:
                note_pause(flow, stage, paused_at, time.time())
                self.pending.pop(token, None)
                if flow.id in self.records and self.records[flow.id]["state"] == "paused":
                    self.records[flow.id]["state"] = "streaming" if stage == "event" else "pending"
                self.changed()
        return value

    def client_connected(self, client):
        url = os.environ.get("STREAMGLASS_SCRIPT_URL")
        if (self.settings["capturePaused"] or not url or client.id in self.applications
                or sum(entry["task"] is not None for entry in self.applications.values()) >= 16):
            return
        if len(self.applications) >= MAX_RECORDS:
            oldest = next(iter(self.applications))
            entry = self.applications.pop(oldest)
            if entry["task"]:
                entry["task"].cancel()
        entry = {"records": set(), "value": {"application": None, "clientIsLocal": None},
                 "task": None, "disconnected": False}
        self.applications[client.id] = entry
        entry["task"] = asyncio.create_task(self.resolve_application(client, entry, url))

    @staticmethod
    def application_value(value):
        result = {"application": None, "clientIsLocal": None}
        if not isinstance(value, dict):
            return result
        if type(value.get("clientIsLocal", "pinned")) is bool:
            result["clientIsLocal"] = value["clientIsLocal"]
        app = value.get("application")
        if result["clientIsLocal"] is not True or not isinstance(app, dict):
            return result
        for key, limit in (("id", 512), ("name", 256), ("kind", 64)):
            if not isinstance(app.get(key), str) or not 0 < len(app[key]) <= limit or any(ord(c) < 32 for c in app[key]):
                return result
        if type(app.get("pid")) is not int or not 0 < app["pid"] <= 2 ** 31 - 1:
            return result
        checked = {key: app[key] for key in ("id", "name", "kind", "pid")}
        for key, limit in (("bundleId", 512), ("platform", 64)):
            if key in app:
                if not isinstance(app[key], str) or not 0 < len(app[key]) <= limit or any(ord(c) < 32 for c in app[key]):
                    return result
                checked[key] = app[key]
        if app.get("icon") is not None:
            icon = app["icon"]
            if not isinstance(icon, str) or len(icon) > 256 * 1024 or not icon.startswith("data:image/png;base64,"):
                return result
            try:
                raw = base64.b64decode(icon.split(",", 1)[1], validate=True)
            except ValueError:
                return result
            if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                return result
            checked["icon"] = icon
        result["application"] = checked
        return result

    async def resolve_application(self, client, entry, url):
        try:
            # A separate connector keeps OS attribution off the script/forwarding path.
            async with ClientSession(timeout=ClientTimeout(total=12)) as session:
                async with session.post(url.rstrip("/") + "/application",
                                        json={"clientHost": str(client.peername[0]), "clientPort": client.peername[1],
                                              "proxyPort": self.settings["proxyPort"]},
                                        headers={"Authorization": "Bearer " + self.token}) as response:
                    if response.status == 200:
                        try:
                            await response.content.readexactly(384 * 1024 + 1)
                        except asyncio.IncompleteReadError as exc:
                            entry["value"] = self.application_value(json.loads(exc.partial))
            for record_id in entry["records"]:
                if record := self.records.get(record_id):
                    record.update(entry["value"])
                    self.save(record)
        except (ClientError, TimeoutError, ValueError, OSError, sqlite3.Error):
            pass
        finally:
            entry["records"].clear()
            entry["task"] = None
            if entry["disconnected"] and self.applications.get(client.id) is entry:
                self.applications.pop(client.id, None)

    def attribute_record(self, client, record):
        record.update(application=None, clientIsLocal=None)
        if entry := self.applications.get(client.id):
            record.update(entry["value"])
            if entry["task"]:
                entry["records"].intersection_update(self.records)
                if len(entry["records"]) >= MAX_RECORDS:
                    entry["records"].pop()
                entry["records"].add(record["id"])
        return record

    async def refresh_application_icons(self):
        url = os.environ.get("STREAMGLASS_SCRIPT_URL")
        if not url:
            return
        ids = {record["application"]["id"] for record in self.records.values()
               if isinstance(record.get("application"), dict) and record["application"].get("kind") == "application"}
        async with ClientSession(timeout=ClientTimeout(total=12)) as session:
            for app_id in ids:
                try:
                    async with session.post(url.rstrip("/") + "/application-icon", json={"id": app_id},
                                            headers={"Authorization": "Bearer " + self.token}) as response:
                        if response.status != 200:
                            continue
                        try:
                            await response.content.readexactly(384 * 1024 + 1)
                            continue
                        except asyncio.IncompleteReadError as exc:
                            result = json.loads(exc.partial)
                    if not isinstance(result, dict) or result.get("id") != app_id or not result.get("icon"):
                        continue
                    for record in list(self.records.values()):
                        app = record.get("application")
                        if not app or app.get("id") != app_id or app.get("icon") == result["icon"]:
                            continue
                        checked = self.application_value({"clientIsLocal": True, "application": {**app, "icon": result["icon"]}})
                        if checked["application"]:
                            record["application"] = checked["application"]
                            self.save(record)
                except (ClientError, TimeoutError, ValueError, OSError, sqlite3.Error):
                    continue

    def http_connect(self, flow):
        # Connections outlive captures, including when capture is paused or deleted.
        self.active_tunnels[flow.client_conn.id] = flow
        if self.settings["capturePaused"]:
            return
        self.tunnels[flow.client_conn.id] = flow.id
        host, port = flow.request.host, flow.request.port
        authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        self.save(self.attribute_record(flow.client_conn, {"id": flow.id, "kind": "tunnel", "isEncrypted": True, "sslInspected": False,
                   "host": host, "port": port, "url": authority, "method": "CONNECT",
                   "device": str(flow.client_conn.peername[0]), "startedAt": time.time(),
                   "state": "pending", "eventCount": 0, "events": []}))

    def http_connected(self, flow):
        if record := self.records.get(flow.id):
            if record["state"] != "interrupted":
                record["state"] = "connected"
                self.save(record)

    def http_connect_error(self, flow):
        self.cancel(flow.id, str(flow.error or f"CONNECT failed ({flow.response.status_code if flow.response else 'no response'})"))

    def client_disconnected(self, client):
        if entry := self.applications.get(client.id):
            entry["disconnected"] = True
            if not entry["task"]:
                self.applications.pop(client.id, None)
        self.active_tunnels.pop(client.id, None)
        established = client.id in self.tls_established_clients
        self.tls_established_clients.discard(client.id)
        record_id = self.tunnels.pop(client.id, None)
        if record := self.records.get(record_id):
            if record["state"] not in ("error", "interrupted"):
                record["state"] = "complete"
                # TLS with our certificate succeeded but no request followed: typical of pinning checked after the
                # handshake (e.g. OkHttp CertificatePinner), or an unused pre-connection.
                if established and not record.get("tlsFailure"):
                    record["sslInspected"] = True
                    record["tlsFailure"] = {"side": "client", "reason": "Client closed the connection after the TLS handshake without sending a request",
                                            "at": time.time(), "likelyCause": "closed-after-handshake"}
                self.save(record)

    def server_connect_error(self, data):
        if record_id := self.tunnels.get(data.client.id):
            self.cancel(record_id, str(data.server.error))

    def tls_failure_cause(self, side, reason, device, host):
        text = (reason or "").lower()
        if side == "server":
            return "protocol" if any(w in text for w in ("protocol", "does not speak tls", "no shared cipher", "handshake failure")) else "unknown"
        count = self.tls_failure_counts[(device, host)] = self.tls_failure_counts.get((device, host), 0) + 1
        if "disconnected during the handshake" in text or "closed" in text or "eof" in text:
            # A hang-up mid-handshake usually means the device does not (fully) trust the CA, e.g. an iOS profile installed
            # without enabling full trust. Only once this device has completed other inspected handshakes is pinning likelier.
            return "pinning" if device in self.tls_ok_devices else "untrusted-ca"
        if any(w in text for w in ("unknown ca", "bad certificate", "certificate unknown", "unknown_ca", "does not trust")):
            # Repeated rejections while the same device completes other handshakes point at pinning rather than a missing CA.
            return "pinning" if count > 1 and device in self.tls_ok_devices else "untrusted-ca"
        if any(w in text for w in ("protocol", "does not speak tls", "no shared cipher", "handshake failure", "version")):
            return "protocol"
        return "unknown"

    def tls_failed_client(self, data, side="client"):
        client = data.context.client
        reason = str(data.conn.error or "TLS handshake failed")
        server = getattr(data.context, "server", None)
        address = getattr(server, "address", None) or (None, None)
        record_id = self.tunnels.get(client.id)
        record = self.records.get(record_id) if record_id else None
        host = (record or {}).get("host") or address[0] or getattr(client, "sni", None)
        port = (record or {}).get("port") or address[1] or 443
        device = str(client.peername[0]) if client.peername else ""
        failure = {"side": side, "reason": reason, "at": time.time(), "likelyCause": self.tls_failure_cause(side, reason, device, host)}
        if record is None:
            if self.settings["capturePaused"] or not host:
                return
            record_id = str(uuid.uuid4())
            authority = f"[{host}]:{port}" if ":" in str(host) else f"{host}:{port}"
            record = self.attribute_record(client, {"id": record_id, "kind": "tunnel", "isEncrypted": True, "sslInspected": True,
                      "host": host, "port": port, "url": authority, "method": "CONNECT", "device": device,
                      "startedAt": time.time(), "state": "pending", "eventCount": 0, "events": []})
            self.save(record)
        record["tlsFailure"] = failure
        record["sslInspected"] = True
        self.save(record)
        self.cancel(record_id, reason)

    def tls_failed_server(self, data):
        self.tls_failed_client(data, "server")

    def done(self):
        for entry in self.applications.values():
            if entry["task"]:
                entry["task"].cancel()
        self.applications.clear()
        for record_id in self.tunnels.values():
            if record := self.records.get(record_id):
                if record["state"] not in ("error", "interrupted"):
                    record["state"] = "complete"
                    self.save(record)
        self.tunnels.clear()
        self.active_tunnels.clear()

    def tls_established_client(self, data):
        self.active_tunnels.pop(data.context.client.id, None)
        self.tls_established_clients.add(data.context.client.id)
        if data.context.client.peername:
            self.tls_ok_devices.add(str(data.context.client.peername[0]))

    async def requestheaders(self, flow):
        if self.settings["capturePaused"]:
            flow.metadata["streamglass_passthrough"] = True
            return
        self.flows[flow.id] = flow
        map_local_active = any(rule["enabled"] for rule in self.traffic_tools["mapLocalRules"])
        if map_local_active or traffic_rules.needs_request_buffer(self, flow):
            flow.metadata["streamglass_map_buffer"] = True
            flow.request.stream = False
            length = flow.request.headers.get("content-length", "")
            if length.isdecimal() and int(length) > MAX_BODY:
                flow.metadata["streamglass_map_upload_error"] = ("Map Local" if map_local_active else "Block rules") + " require request uploads of at most 8 MiB; no upstream request was sent."
                from mitmproxy import http
                flow.response = http.Response.make(413, flow.metadata["streamglass_map_upload_error"].encode())
                flow.metadata["streamglass_passthrough"] = True
                self.error(flow)
                return
        network = network_for(self, flow)
        if network:
            await traffic_wait(self, flow, network["delayMs"] / 1000)
            flow.metadata["streamglass_transfer_rates"] = (network["uploadKbps"], network["downloadKbps"])

    async def request(self, flow):
        self.active_tunnels.pop(flow.client_conn.id, None)
        # Inspected HTTP requests replace their provisional CONNECT row.
        if tunnel_id := self.tunnels.pop(flow.client_conn.id, None):
            if self.records.get(tunnel_id, {}).get("pinned"):
                self.records[tunnel_id]["state"] = "complete"
                self.save(self.records[tunnel_id])
            else:
                self.forget_record(tunnel_id)
            self.db.commit()
            self.changed()
        self.flows[flow.id] = flow
        try:
            if self.bypass_rules(flow):
                flow.metadata["streamglass_passthrough"] = True
                return
            if not self.settings["capturePaused"]:
                record = {"id": flow.id, "kind": "request", "isEncrypted": False, "sslInspected": flow.request.scheme == "https",
                          "host": flow.request.host, "port": flow.request.port,
                          "url": flow.request.url, "method": flow.request.method, "device": str(flow.client_conn.peername[0]),
                          "startedAt": time.time(), "state": "pending", "eventCount": 0, "events": [], "request": message_value(flow.request, True)}
                self.save(self.attribute_record(flow.client_conn, record))
            original_request = copy.deepcopy(flow.request) if any(rule["enabled"] for rule in self.traffic_tools["mapLocalRules"]) or any(rule["enabled"] for rule in self.scenarios) or traffic_rules.rules_active(self.traffic_tools) else None
            original = message_value(flow.request, True)
            value = await self.process(flow, "request", original)
            if value != original:
                apply_message(flow.request, value, True)
            # Order: Block, then Map Local, then (when no response was supplied) Map Remote and request Rewrite.
            blocked = traffic_rules.block_request(self, flow)
            if blocked == "close":
                if flow.id in self.records:
                    self.records[flow.id]["appliedRules"] = list(flow.metadata["streamglass_applied_rules"])
                self.fail(flow, "Connection closed by Block rule " + flow.metadata["streamglass_applied_rules"][-1]["name"])
                return
            if not blocked:
                map_response(self, flow)
                if flow.response is None:
                    traffic_rules.map_remote(self, flow)
                    traffic_rules.rewrite_request(self, flow)
                from .lab import on_request
                on_request(self, flow)
            if flow.metadata.get("streamglass_map_local"):
                flow.metadata["streamglass_original_request"] = original_request
            flow.metadata["streamglass_forwarded_at"] = time.time()
            if flow.id in self.records:
                self.records[flow.id].update(request=message_value(flow.request, True), url=flow.request.url, method=flow.request.method)
                if flow.metadata.get("streamglass_applied_rules"):
                    self.records[flow.id]["appliedRules"] = list(flow.metadata["streamglass_applied_rules"])
                self.save(self.records[flow.id])
        except Exception as exc:
            self.fail(flow, str(exc))

    async def responseheaders(self, flow):
        flow.metadata["streamglass_headers_at"] = time.time()
        try:
            traffic_rules.rewrite_response_headers(self, flow)
            if self.bypass_rules(flow):
                flow.metadata["streamglass_response_processed"] = True
                if flow.metadata.pop("streamglass_map_local", None):
                    flow.response = None
                else:
                    flow.response.stream = True
                return
            if flow.metadata.get("streamglass_map_local") and len(flow.response.raw_content or b"") > MAX_BODY and "text/event-stream" not in flow.response.headers.get("content-type", "").lower():
                original = {"headers": list(flow.response.headers.items(multi=True)), "statusCode": flow.response.status_code,
                            "body": "", "bodyBase64": "", "bodyUnavailable": True,
                            "bodyUnavailableReason": "Large Map Local body; only headers and status can be edited."}
                value = await self.process(flow, "response", original)
                if value != original:
                    from .large_body import apply_streamed_headers
                    apply_streamed_headers(flow.response, value)
                flow.metadata["streamglass_response_processed"] = True
                if self.bypass_rules(flow):
                    flow.metadata.pop("streamglass_map_local", None)
                    flow.response = None
                return
            if await before_responseheaders(self, flow):
                return
            if "text/event-stream" not in flow.response.headers.get("content-type", "").lower():
                return
            if record := self.records.get(flow.id):
                record["isSSE"] = True
                self.changed()
            original = message_value(flow.response)
            value = await self.process(flow, "response", original)
            if value != original:
                apply_message(flow.response, value, headers_only=True)
            if self.bypass_rules(flow):
                flow.metadata["streamglass_response_processed"] = True
                if flow.metadata.pop("streamglass_map_local", None):
                    flow.response = None
                else:
                    flow.response.stream = True
                return
            flow.metadata["streamglass_response_processed"] = True
            if flow.response.status_code in (204, 304) or flow.request.method == "HEAD":
                return
            coding = flow.response.headers.get("content-encoding", "identity").lower().strip()
            if coding in ("gzip", "x-gzip"):
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            elif coding == "deflate":
                decoder = zlib.decompressobj()
            elif coding == "br":
                import brotli
                decoder = brotli.Decompressor()
            elif coding in ("identity", ""):
                decoder = None
            else:
                raise ValueError(f"SSE content encoding {coding!r} is unsupported; request identity/gzip/deflate/br")
            flow.metadata["streamglass_sse_stream"] = True
            self.streams[flow.id] = {"parser": SSEParser(), "decoder": decoder, "sequence": 0, "bytes": 0}
            flow.response.headers.pop("content-encoding", None)
            flow.response.headers.pop("content-length", None)
            flow.response.stream = lambda chunk: chunk
            if flow.id in self.records:
                self.records[flow.id]["sseDiagnostics"] = {"headersAt": flow.metadata.get("streamglass_headers_at", time.time()), "firstEventAt": None, "lastEventAt": None, "eventCount": 0, "endReason": None}
                self.records[flow.id].update(state="streaming", isSSE=True, statusCode=flow.response.status_code, response=message_value(flow.response))
                self.save(self.records[flow.id])
        except Exception as exc:
            self.fail(flow, str(exc))

    async def streamglass_transfer(self, hook):
        if getattr(hook, "disconnect", False):
            self.fail(hook.flow, "Scenario disconnected after configured event count")
            return
        if getattr(hook, "delay_ms", 0):
            await traffic_wait(self, hook.flow, hook.delay_ms / 1000)
        network = network_for(self, hook.flow)
        if network:
            rate = network["uploadKbps" if hook.upload else "downloadKbps"]
            if rate:
                await traffic_wait(self, hook.flow, hook.size * 8 / (rate * 1000))

    async def streamglass_responsestream(self, flow):
        try:
            if not self.bypass_rules(flow):
                await before_responseheaders(self, flow, streaming=True)
        except Exception as exc:
            self.fail(flow, str(exc))

    async def streamglass_responsechunk(self, hook):
        flow, data, end, chunks = hook.flow, hook.data, hook.end, hook.chunks
        stream = self.streams.get(flow.id)
        if stream is None:
            observe_responsechunk(self, flow, data)
            if data:
                chunks.append(data)
            return
        try:
            if self.bypass_rules(flow) and stream["parser"] is not None:
                parser = stream["parser"]
                buffered = bytes(parser.block + parser.buffer)
                if buffered:
                    chunks.append(buffered)
                # Once raw bytes bypass framing, parsing cannot safely resume mid-event.
                stream["parser"] = None
            decoder = stream["decoder"]
            def decoded_chunks():
                if decoder is None:
                    yield data
                elif hasattr(decoder, "process"):
                    # Bound Brotli output allocations by feeding small wire fragments.
                    for offset in range(0, len(data), 1024):
                        yield decoder.process(data[offset:offset + 1024])
                    if end and not decoder.is_finished():
                        raise ValueError("Truncated compressed SSE stream")
                else:
                    wire = data
                    while wire:
                        yield decoder.decompress(wire, 64 * 1024)
                        wire = decoder.unconsumed_tail
                    if end:
                        yield decoder.flush()
                        if not decoder.eof:
                            raise ValueError("Truncated compressed SSE stream")

            for decoded in decoded_chunks():
                if stream["parser"] is None:
                    if decoded:
                        chunks.append(decoded)
                    continue
                try:
                    events = stream["parser"].feed(decoded, end)
                except EventTooLarge as exc:
                    if self.matching_rules(flow, "event"):
                        raise ValueError("SSE event exceeds 8 MiB event-editing limit; disable matching event rules to stream larger events")
                    events = exc.events
                    stream["parser"] = None
                    if record := self.records.get(flow.id):
                        record["captureWarning"] = "SSE event exceeds 8 MiB; remaining stream forwarded without event capture or editing."
                        self.save(record)
                    events.append({"dispatch": False, "_bytes": exc.raw})
                for event in events:
                    if event["dispatch"]:
                        stream["sequence"] += 1
                        event["sequence"] = stream["sequence"]
                        chunks.append(event)
                    else:
                        chunks.append(event["_bytes"])
        except Exception as exc:
            self.fail(flow, str(exc))

    async def streamglass_sseevent(self, hook):
        flow, event, output = hook.flow, hook.event, hook.output
        try:
            raw = event.pop("_bytes")
            received = time.time()
            gap_ms = None
            if record := self.records.get(flow.id):
                diagnostics = record.setdefault("sseDiagnostics", {})
                previous_at = diagnostics.get("lastEventAt") or diagnostics.get("headersAt")
                if previous_at is not None:
                    gap_ms = max(0.0, (received - previous_at) * 1000)
                    diagnostics["gapStats"] = flow.metadata.setdefault("streamglass_sse_gaps", GapStats()).add(gap_ms)
                diagnostics.update(firstEventAt=diagnostics.get("firstEventAt") or received, lastEventAt=received, eventCount=event["sequence"], eventBytes=diagnostics.get("eventBytes", 0) + len(raw))
            from .lab import on_event
            forward = await on_event(self, flow, event)
            value = await self.process(flow, "event", dict(event))
            raw = raw if value == event else serialize(value)
            value["receivedAt"] = received
            if gap_ms is not None:
                value["gapMs"] = gap_ms
            value["forwarded"] = forward
            value["processedAt"] = time.time()
            value["timingDeferred"] = bool(flow.metadata.get("streamglass_fixture_delays") or flow.metadata.get("streamglass_transfer_rates", (0, 0))[1])
            if self.bypass_rules(flow):
                output.append(raw)
                return
            value["raw"] = raw.decode("utf-8", "replace")
            if value["raw"].encode() != raw:
                value["rawBase64"] = base64.b64encode(raw).decode()
            stream = self.streams[flow.id]
            stream["bytes"] += len(raw)
            if flow.id in self.records:
                record = self.records[flow.id]
                record["eventCount"] = event["sequence"]
                retained = False
                if not record.get("captureWarning"):
                    if stream["bytes"] > MAX_CAPTURE // 2:
                        record["captureWarning"] = "SSE capture reached its storage limit; later events continue forwarding without retention."
                    else:
                        record["events"].append(value)
                        retained = True
                try:
                    self.save(record)
                except ValueError:
                    if not retained:
                        raise
                    record["events"].pop()
                    record["captureWarning"] = "SSE capture reached its storage limit; later events continue forwarding without retention."
                    self.save(record)
            if forward:
                output.append(raw)
        except Exception as exc:
            self.fail(flow, str(exc))

    async def response(self, flow):
        try:
            if (record := self.records.get(flow.id)) and flow.response and not flow.metadata.get("streamglass_map_local"):
                record["timings"] = compute_timings(flow, flow.metadata.get("streamglass_forwarded_at"), getattr(flow.response, "timestamp_end", None) or time.time())
            if self.bypass_rules(flow):
                if flow.metadata.pop("streamglass_map_local", None):
                    flow.response = None
                    return
                if record := self.records.get(flow.id):
                    response = message_value(flow.response)
                    response.update(bodyUnavailable=True, bodyUnavailableReason="Capture was paused; the complete response body was not retained.")
                    record.update(state="complete", statusCode=flow.response.status_code, response=response)
                    self.save(record)
                return
            traffic_rules.rewrite_response_headers(self, flow)
            traffic_rules.rewrite_response_body(self, flow)
            if flow.metadata.get("streamglass_map_local") and flow.id in self.streams:
                hook = SimpleNamespace(flow=flow, data=flow.response.raw_content or b"", end=True, chunks=[])
                await self.streamglass_responsechunk(hook)
                output = []
                timed_frames = []
                delays = iter(flow.metadata.get("streamglass_fixture_delays", []))
                for chunk in hook.chunks:
                    if isinstance(chunk, dict):
                        event_hook = SimpleNamespace(flow=flow, event=chunk, output=[])
                        await self.streamglass_sseevent(event_hook)
                        output.extend(event_hook.output)
                        scenario = flow.metadata.get("streamglass_scenario", {})
                        event_delay = scenario.get("delayMs", 0) if scenario.get("action") == "delay-events" and chunk.get("event", "").lower() != "context" else 0
                        timed_frames.extend((len(raw), next(delays, 0) + event_delay) for raw in event_hook.output)
                    else:
                        output.append(chunk)
                        timed_frames.append((len(chunk), 0))
                if any(delay for _, delay in timed_frames):
                    flow.metadata["streamglass_timed_frames"] = timed_frames
                flow.response.raw_content = b"".join(output)
                flow.response.headers["content-length"] = str(len(flow.response.raw_content))
            if complete_response(self, flow):
                return
            if flow.id not in self.streams and not flow.metadata.get("streamglass_response_processed"):
                original = message_value(flow.response)
                value = await self.process(flow, "response", original)
                if value != original:
                    apply_message(flow.response, value, headers_only=flow.request.method == "HEAD")
            if self.bypass_rules(flow) and flow.metadata.pop("streamglass_map_local", None):
                flow.response = None
                return
            if flow.id in self.records:
                record = self.records[flow.id]
                if flow.metadata.get("streamglass_map_local") and len(flow.response.raw_content or b"") > MAX_BODY:
                    raw = flow.response.raw_content
                    captured = {"headers": list(flow.response.headers.items(multi=True)), "statusCode": flow.response.status_code,
                                "body": "", "bodyBase64": "", "bodyUnavailable": True, "bodyBytes": len(raw),
                                "bodyPreview": raw[:65536].decode("utf-8", "replace"), "bodyPreviewBytes": min(len(raw), 65536),
                                "bodyUnavailableReason": "Map Local response exceeds body retention limit; bounded preview retained."}
                else:
                    captured = message_value(flow.response)
                record.update(response=captured, statusCode=flow.response.status_code, state="complete")
                self.save(record)
        except Exception as exc:
            self.fail(flow, str(exc))
        finally:
            flow.metadata.pop("streamglass_original_request", None)
            self.streams.pop(flow.id, None)
            self.flows.pop(flow.id, None)

    def error(self, flow):
        if flow.id not in self.records and flow.metadata.get("streamglass_map_upload_error"):
            self.save({"id": flow.id, "kind": "request", "url": flow.request.url, "method": flow.request.method,
                       "device": str(flow.client_conn.peername[0]), "startedAt": time.time(), "state": "error",
                       "error": flow.metadata["streamglass_map_upload_error"], "eventCount": 0, "events": [],
                       "request": {"url": flow.request.url, "method": flow.request.method, "headers": list(flow.request.headers.items(multi=True)),
                                   "body": "", "bodyBase64": "", "bodyUnavailable": True}})
        self.cancel(flow.id, str(flow.error))
        self.streams.pop(flow.id, None)
        self.flows.pop(flow.id, None)

    def fail(self, flow, message):
        if (diagnostics := self.records.get(flow.id, {}).get("sseDiagnostics")) is not None and not diagnostics.get("endedAt"):
            diagnostics["endReason"] = "proxy-closed"
        flow.kill()
        self.cancel(flow.id, message)

    def tls_patterns(self, domains=None):
        if domains is None:
            domains = self.settings["tlsDomains"]
        return ["^" + re.escape(domain).replace(r"\*", ".*") + r"(?::\d+)?$" for domain in domains] or ["(?!)"]

    def interrupt_newly_inspected_tunnels(self, previous_domains):
        previous = [re.compile(pattern, re.IGNORECASE) for pattern in self.tls_patterns(previous_domains)]
        current = [re.compile(pattern, re.IGNORECASE) for pattern in self.tls_patterns()]
        proxyserver = self.master.addons.get("proxyserver")
        interrupted = 0
        for client_id, flow in list(self.active_tunnels.items()):
            if flow.client_conn.tls:
                continue
            hosts = {f"{flow.request.host}:{flow.request.port}"}
            for address in (flow.server_conn.address, flow.server_conn.peername):
                if address:
                    hosts.add(f"{address[0]}:{address[1]}")
            if flow.client_conn.sni:
                hosts.add(f"{flow.client_conn.sni}:{flow.request.port}")
            if any(pattern.search(host) for pattern in previous for host in hosts):
                continue
            if not any(pattern.search(host) for pattern in current for host in hosts):
                continue
            # Opaque CONNECT flows are not killable HTTP flows in the pinned engine.
            handler = proxyserver.connections.get(client_id)
            if handler and handler.client in handler.transports and handler.transports[handler.client].handler:
                if (record := self.records.get(flow.id)) and not record.get("error"):
                    record.update(state="interrupted", interruptionReason=SSL_INTERRUPTION_REASON)
                    self.save(record)
                handler.close_connection(handler.client)
                self.active_tunnels.pop(client_id, None)
                interrupted += 1
        return interrupted

    def running(self):
        self.proxy_ready.set()

    async def start_proxy(self):
        if not self.settings["proxyEnabled"]:
            return
        from mitmproxy import options
        from mitmproxy.tools.dump import DumpMaster
        opts = options.Options(listen_host=self.settings["listenHost"], listen_port=self.settings["proxyPort"], confdir=str(self.directory / "mitmproxy"), ssl_insecure=False)
        self.proxy_ready = asyncio.Event()
        self.master = DumpMaster(opts, with_termlog=False, with_dumper=False)
        # The CLI error checker exits the entire management process on bind errors.
        errorcheck = self.master.addons.get("errorcheck")
        errorcheck.finish()
        self.master.addons.remove(errorcheck)
        self.master.options.update(allow_hosts=self.tls_patterns(), body_size_limit=None, stream_large_bodies="8m", connection_strategy="lazy")
        self.master.addons.add(self)
        self.proxy_task = asyncio.create_task(self.master.run())
        ready = asyncio.create_task(self.proxy_ready.wait())
        done, _ = await asyncio.wait((ready, self.proxy_task), timeout=10, return_when=asyncio.FIRST_COMPLETED)
        proxyserver = self.master.addons.get("proxyserver")
        if ready not in done or self.proxy_task.done() or not proxyserver.listen_addrs():
            ready.cancel()
            await proxyserver.servers.update([])
            self.master.shutdown()
            await self.proxy_task
            self.master = None
            self.proxy_error = (f"Could not listen on port {self.settings['proxyPort']}. Another app (for example Proxyman or Charles) "
                                "is probably using it. Choose a different port in Settings → Proxy.")
            self.changed()
            raise ValueError("Proxy listener failed to start")
        self.proxy_error = ""
        self.changed()

import asyncio
import copy
import hashlib
import hmac
import json
import re
import shlex
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from aiohttp import web

from .service import MAX_BODY, is_sse
from .sse import exported
from .sse_status import sse_status
from .search import search as search_records
from .custom_fields import evaluate as evaluate_fields


@lru_cache(maxsize=1)
def public_suffix_list():
    from publicsuffix2 import PublicSuffixList
    with (Path(__file__).resolve().parent / "data" / "public_suffix_list.dat").open(encoding="utf-8") as source:
        return PublicSuffixList(source)


def create_app(service, *, allow_dev_origin=False, mcp_approval_key=None):
    @web.middleware
    async def boundary(request, handler):
        origin = request.headers.get("Origin")
        allowed = {"app://streamglass", f"http://127.0.0.1:{service.port}", f"http://localhost:{service.port}"}
        if allow_dev_origin:
            allowed.update(("http://127.0.0.1:5173", "http://localhost:5173"))
        if request.host not in (f"127.0.0.1:{service.port}", f"localhost:{service.port}"):
            return web.json_response({"error": {"code": "host_denied", "message": "Invalid management host"}}, status=403)
        if origin and origin not in allowed:
            return web.json_response({"error": {"code": "origin_denied", "message": "Untrusted management origin"}}, status=403)
        def cors(response):
            response.headers["Cache-Control"] = "no-store"
            if origin:
                response.headers["Access-Control-Allow-Origin"] = origin
                response.headers["Vary"] = "Origin"
                response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
                response.headers["Access-Control-Allow-Methods"] = "GET, PUT, POST, PATCH, DELETE, OPTIONS"
            return response
        if request.method == "OPTIONS":
            return cors(web.Response(status=204))
        authorization = request.headers.get("Authorization", "")
        supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied.encode("utf-8"), service.token.encode("utf-8")):
            return cors(web.json_response({"error": {"code": "unauthorized", "message": "Management token required"}}, status=401))
        try:
            return cors(await handler(request))
        except web.HTTPException as exc:
            return cors(web.json_response({"error": {"code": "http_error", "message": exc.reason}}, status=exc.status))
        except (ValueError, KeyError, TypeError, UnicodeError) as exc:
            return cors(web.json_response({"error": {"code": "invalid_request", "message": str(exc)}}, status=400))

    app = web.Application(middlewares=[boundary], client_max_size=48 * 1024 * 1024)

    async def state(request):
        # Pollers pass the etag they last saw; an unchanged snapshot answers with a few bytes instead of every row.
        etag, body = service.state_json(request.query.get("since"))
        if request.query.get("etag") == etag:
            return web.json_response({"unchanged": True, "etag": etag})
        return web.Response(text=body, content_type="application/json")

    async def pending(request):
        return web.json_response({"capturePaused": service.settings["capturePaused"], "pending": service.pending_summary()})

    async def record(request):
        value = service.records.get(request.match_info["id"])
        if not value:
            raise web.HTTPNotFound()
        result = {**value, "isSSE": is_sse(value), **({"sseStatus": sse_status(value)} if is_sse(value) else {})}
        # The inspector asks for compact events (no raw wire copies) and only the events it has not seen yet.
        events = value.get("events")
        if isinstance(events, list) and ("afterEvent" in request.query or request.query.get("compact") == "1"):
            start = int(request.query.get("afterEvent", "0"))
            start = start if 0 <= start <= len(events) else 0
            selected = events[start:]
            if request.query.get("compact") == "1":
                selected = [{key: item for key, item in event.items() if key not in ("raw", "rawBase64")} for event in selected]
            result.update(events=selected, eventsFrom=start)
        return web.json_response(result)

    async def lan_device(request):
        """Approve or refuse a LAN device; approval persists in settings.lanDevices."""
        value = await request.json()
        if not isinstance(value, dict) or set(value) != {"address", "allow"} or type(value["allow"]) is not bool or not isinstance(value["address"], str):
            raise ValueError("Expected device address and allow boolean")
        service.lan_guard.decide(value["address"], value["allow"])
        return web.json_response({"lanDevices": service.settings["lanDevices"], "lanRequests": service.lan_guard.summary()})

    async def traffic_tools(request):
        if request.method == "PUT":
            from .traffic_tools import validate
            body = await request.json()
            if not isinstance(body, dict) or "revision" not in body:
                return web.json_response({"error": {"code": "revision_required", "message": "Read /api/traffic-tools and include its revision when saving traffic tools."}}, status=428)
            if set(body) != {"revision", "config"} or type(body["revision"]) is not int or body["revision"] < 0:
                raise ValueError("Expected traffic tools config and a nonnegative integer revision")
            if body["revision"] != service.traffic_tools_revision:
                return web.json_response({"error": {"code": "revision_conflict", "message": "Traffic tools changed in another window or MCP client. Reload before saving."}, "trafficToolsRevision": service.traffic_tools_revision}, status=409)
            value = validate(body["config"])
            service.persist_config(traffic_tools=value)
        return web.json_response({"config": service.traffic_tools, "revision": service.traffic_tools_revision})

    async def pin(request):
        record = service.records.get(request.match_info["id"])
        if record is None:
            raise web.HTTPNotFound()
        value = await request.json()
        if not isinstance(value, dict) or set(value) != {"pinned"} or type(value["pinned"]) is not bool:
            raise ValueError("Expected pinned boolean")
        updated = {**record, "pinned": value["pinned"]}
        service.save(updated)
        return web.json_response({"id": record["id"], "pinned": updated["pinned"]})

    async def search(request):
        return web.json_response(await search_records(service, request.query.get("scope", "url"), request.query.get("q", ""), request.query.get("mode", "contains")))

    async def settings(request):
        changes = await request.json()
        if isinstance(changes, dict) and "mcpTlsBaseline" in changes:
            baseline = changes.pop("mcpTlsBaseline")
            if not isinstance(baseline, list) or not all(isinstance(item, str) for item in baseline):
                raise ValueError("Expected the prior TLS domain patterns")
            if set(baseline) != set(service.settings["tlsDomains"]):
                return web.json_response({"error": {"code": "revision_conflict", "message": "TLS patterns changed. Read settings again before editing."}}, status=409)
        if isinstance(changes, dict) and "running" in changes:
            changes["proxyEnabled"] = changes.pop("running")
        if not isinstance(changes, dict) or set(changes) - {"capturePaused", "proxyEnabled", "proxyPort", "listenHost", "tlsDomains", "lanDevices", "lanDeviceExpiry", "lanAllowedDestinations", "inspectedStorageMiB"}:
            raise ValueError("Unknown settings")
        from .lan_guard import validate_devices, validate_destinations
        if "lanDevices" in changes:
            changes["lanDevices"] = validate_devices(changes["lanDevices"])
        if "lanAllowedDestinations" in changes:
            changes["lanAllowedDestinations"] = validate_destinations(changes["lanAllowedDestinations"])
        if "inspectedStorageMiB" in changes:
            from .service import INSPECTED_MIB_RANGE
            low, high = INSPECTED_MIB_RANGE
            if type(changes["inspectedStorageMiB"]) is not int or not low <= changes["inspectedStorageMiB"] <= high:
                raise ValueError(f"inspectedStorageMiB must be an integer from {low} to {high}")
        if "lanDeviceExpiry" in changes:
            if type(changes["lanDeviceExpiry"]) is not bool:
                raise ValueError("lanDeviceExpiry must be boolean")
            # Turning expiry back on gives every approved device a fresh 24 hours instead of dropping old ones at once.
            if changes["lanDeviceExpiry"] and not service.settings.get("lanDeviceExpiry", True):
                service.settings["lanDeviceApprovals"] = {}
        if "proxyEnabled" in changes and type(changes["proxyEnabled"]) is not bool:
            raise ValueError("proxyEnabled must be boolean")
        if "capturePaused" in changes and type(changes["capturePaused"]) is not bool:
            raise ValueError("capturePaused must be boolean")
        if "proxyPort" in changes and (type(changes["proxyPort"]) is not int or not 1024 <= changes["proxyPort"] <= 65535 or changes["proxyPort"] == service.port):
            raise ValueError("Proxy port must be 1024..65535 and different from management port")
        if "listenHost" in changes and changes["listenHost"] not in ("127.0.0.1", "0.0.0.0"):
            raise ValueError("listenHost must be 127.0.0.1 or 0.0.0.0")
        if "tlsDomains" in changes:
            domains = changes["tlsDomains"]
            if not isinstance(domains, list) or len(domains) > 1000 or any(not isinstance(d, str) or not d or len(d) > 255 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.*-_:" for c in d) for d in domains):
                raise ValueError("tlsDomains must contain domain wildcard patterns")
        changed_listener = any(changes.get(key, service.settings[key]) != service.settings[key] for key in ("proxyPort", "listenHost"))
        if changed_listener and changes.get("proxyEnabled", service.settings["proxyEnabled"]) and service.flows:
            raise ValueError("Wait for active flows to finish before changing proxy listener")
        previous = dict(service.settings)
        interrupted = 0
        if "capturePaused" in changes:
            service.set_capture_paused(changes["capturePaused"])
        service.settings.update(changes)
        if changed_listener or changes.get("proxyEnabled", previous["proxyEnabled"]) != previous["proxyEnabled"]:
            await service.stop_proxy("Proxy stopped by user")
            try:
                await service.start_proxy()
            except Exception:
                failure = service.proxy_error
                service.settings = previous
                service.master = None
                try:
                    await service.start_proxy()
                except ValueError:
                    pass
                raise ValueError(f"{(failure or 'Could not start proxy listener.').rstrip('.')}; previous settings restored.")
        elif service.master:
            service.master.options.update(allow_hosts=service.tls_patterns())
            if "tlsDomains" in changes:
                interrupted = service.interrupt_newly_inspected_tunnels(previous["tlsDomains"])
        if "inspectedStorageMiB" in changes and service.evict("inspected"):
            service.db.commit()  # a smaller budget applies now, not at the next capture
        service.persist_config()
        if "lanDevices" in changes:
            service.lan_guard.close_devices(set(previous["lanDevices"]) - set(service.settings["lanDevices"]))
        return web.json_response({**service.state()["settings"], "interruptedConnections": interrupted})

    async def mcp_tls_patterns(request):
        patterns = await request.json()
        if not isinstance(patterns, list) or len(patterns) > 1000 or any(
                not isinstance(pattern, str) or not 0 < len(pattern) <= 255 for pattern in patterns):
            raise ValueError("Expected TLS domain patterns")
        for pattern in patterns:
            if "*" not in pattern:
                continue
            parsed = re.fullmatch(r"\*\.([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)(?::([0-9]{1,5}))?", pattern.lower())
            if not parsed or (parsed[2] and not 1 <= int(parsed[2]) <= 65535):
                raise ValueError("MCP TLS wildcards must use one leading '*.' label and an optional numeric port.")
            suffix = parsed[1]
            last_label = suffix.rsplit(".", 1)[-1]
            if last_label in {"test", "example", "invalid", "localhost", "internal"}:
                public_suffix = last_label
            else:
                try:
                    public_suffix = public_suffix_list().get_tld(suffix, strict=True)
                except (ImportError, OSError, UnicodeError):
                    return web.json_response({"error": {
                        "code": "tls_suffix_data_unavailable",
                        "message": "TLS wildcard validation needs the bundled Public Suffix List. Reinstall Streamglass or use an exact hostname.",
                    }}, status=503)
            if not public_suffix or suffix == public_suffix:
                raise ValueError("MCP TLS wildcards must be scoped to a named site. Use desktop Settings for broader patterns.")
        return web.json_response({"ok": True})

    async def wake(request):
        # Called by the desktop app when the Mac resumes from sleep.
        return web.json_response(await service.recover_after_wake())

    def validate_rules(rules, folders):
        if not isinstance(rules, list) or len(rules) > 500:
            raise ValueError("Expected at most 500 rules")
        ids = set()
        for rule in rules:
            if not isinstance(rule, dict) or not isinstance(rule.get("id"), str) or rule["id"] in ids:
                raise ValueError("Each rule needs a unique string id")
            ids.add(rule["id"])
            if not isinstance(rule.get("pattern"), str) or not rule["pattern"] or len(rule["pattern"]) > 4096:
                raise ValueError("Each rule needs a URL wildcard pattern")
            if not isinstance(rule.get("stages"), list) or not rule["stages"] or not set(rule["stages"]) <= {"request", "response", "event"}:
                raise ValueError("Invalid rule stages")
            if not isinstance(rule.get("script", ""), str) or len(rule.get("script", "")) > 100000:
                raise ValueError("Script exceeds 100 KB")
            if not isinstance(rule.get("method", ""), str):
                raise ValueError("method must be a string")
            for key in ("breakpoint", "enabled"):
                if key in rule and type(rule[key]) is not bool:
                    raise ValueError(f"{key} must be boolean")
            if "order" in rule:
                from .rule_folders import valid_order
                if not valid_order(rule["order"]):
                    raise ValueError("Rule order must be a finite number")
            if "folderId" in rule:
                kind = "scripts" if rule.get("breakpoint") is False else "breakpoints"
                if not isinstance(rule["folderId"], str) or not any(folder["id"] == rule["folderId"] and folder["kind"] == kind for folder in folders):
                    raise ValueError("folderId must reference a folder of the rule's kind")
        return rules

    async def rules(request):
        value = await request.json()
        if not isinstance(value, dict) or "revision" not in value:
            return web.json_response({"error": {"code": "revision_required", "message": "Read rulesRevision from /api/state and include it when saving rules."}}, status=428)
        if set(value) != {"revision", "rules"} or type(value["revision"]) is not int or value["revision"] < 0:
            raise ValueError("Expected rules and a nonnegative integer revision")
        if value["revision"] != service.rules_revision:
            return web.json_response({"error": {"code": "revision_conflict", "message": "Rules changed in another window or MCP client. Reload rules before saving."}, "rulesRevision": service.rules_revision}, status=409)
        from .rule_folders import ordered_rules
        rules = validate_rules(value["rules"], service.folders)
        # Kept in the order the folder tree shows, which is the order rules are tried in.
        service.persist_config(rules=ordered_rules(rules, service.folders))
        return web.json_response({"rules": service.rules, "revision": service.rules_revision})

    async def workspace_config(request):
        def snapshot():
            return {"tlsDomains": service.settings["tlsDomains"], "rules": service.rules,
                    "folders": service.folders, "trafficTools": service.traffic_tools,
                    "scenarios": {"rules": service.scenarios}, "codecs": service.codecs, "productivity": service.productivity}
        if request.method == "GET":
            return web.json_response(snapshot())
        value = await request.json()
        if not isinstance(value, dict) or set(value) - {"tlsDomains", "rules", "folders", "trafficTools", "scenarios", "codecs", "productivity"} or not {"tlsDomains", "rules", "folders", "trafficTools", "scenarios", "codecs"} <= set(value):
            raise ValueError("Expected workspace configuration fields only")
        domains = value["tlsDomains"]
        if not isinstance(domains, list) or len(domains) > 1000 or any(not isinstance(d, str) or not d or len(d) > 255 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.*-_:" for c in d) for d in domains):
            raise ValueError("tlsDomains must contain domain wildcard patterns")
        folders = value["folders"]
        if not isinstance(folders, list) or len(folders) > 500:
            raise ValueError("Expected at most 500 folders")
        from .rule_folders import validate_folders
        folders = validate_folders(folders)
        rules = validate_rules(value["rules"], folders)
        from .traffic_tools import validate
        from .lab import validate_scenarios
        from .codecs import validate_profiles
        codecs = validate_profiles(value["codecs"])
        tools = validate(value["trafficTools"])
        scenarios = validate_scenarios(value["scenarios"])
        from .productivity import validate as validate_productivity, DEFAULT
        productivity = validate_productivity(value.get("productivity", DEFAULT))
        previous = copy.deepcopy(snapshot())
        previous_used = service.scenario_used
        try:
            service.settings["tlsDomains"] = domains
            service.folders, service.scenarios = folders, scenarios
            service.scenario_used = set()
            service.codecs = codecs
            service.productivity = productivity
            if service.master:
                service.master.options.update(allow_hosts=service.tls_patterns())
            service.persist_config(rules=rules, traffic_tools=tools)
        except Exception:
            service.settings["tlsDomains"] = previous["tlsDomains"]
            service.rules, service.folders = previous["rules"], previous["folders"]
            service.traffic_tools, service.scenarios = previous["trafficTools"], previous["scenarios"]["rules"]
            service.scenario_used = previous_used
            service.codecs = previous["codecs"]
            service.productivity = previous["productivity"]
            if service.master:
                service.master.options.update(allow_hosts=service.tls_patterns())
            raise
        if service.master:
            service.interrupt_newly_inspected_tunnels(previous["tlsDomains"])
        service.analysis_cache.clear()
        service.invalidate_fields()
        service.productivity_revision += 1
        return web.json_response(snapshot())

    async def record_fields(request):
        record_id = request.match_info["id"]
        value = service.records.get(record_id)
        if not value:
            raise web.HTTPNotFound()
        return web.json_response({"id": record_id, "rev": service.record_revs.get(record_id, 0), "fields": evaluate_fields(service, value, full=True)})

    async def folder(request):
        """Create, change or delete a rule folder. PATCH takes any of name, parentId (null for the top level), enabled,
        expanded and order. Turning a folder on or off also sets every rule and folder below it, in the same write."""
        from .rule_folders import descendants, ordered_rules, validate_folders, valid_order
        folder_id = request.match_info.get("id")
        existing = next((item for item in service.folders if item["id"] == folder_id), None)
        if folder_id and existing is None:
            raise web.HTTPNotFound(text="Folder not found")
        if request.method == "DELETE":
            # Contents move up one level; nothing inside is deleted or disabled.
            parent = existing.get("parentId")
            def lifted(item, key):
                if item.get(key) != folder_id:
                    return item
                rest = {name: value for name, value in item.items() if name != key}
                return {**rest, key: parent} if parent else rest
            folders = [lifted(item, "parentId") for item in service.folders if item["id"] != folder_id]
            rules = [lifted(rule, "folderId") for rule in service.rules]
            service.persist_config(rules=ordered_rules(rules, folders), folders=folders)
            return web.json_response({"ok": True})
        value = await request.json()
        allowed = {"name", "parentId", "enabled", "expanded", "order"} if existing else {"name", "kind", "parentId", "enabled", "expanded", "order"}
        required = set() if existing else {"name", "kind"}
        if not isinstance(value, dict) or not value or set(value) - allowed or not required <= set(value):
            raise ValueError("Expected folder name" if existing else "Expected folder name and kind")
        result = dict(existing) if existing else {"id": str(uuid.uuid4()), "kind": value["kind"]}
        if "name" in value:
            if not isinstance(value["name"], str) or not value["name"].strip() or len(value["name"].strip()) > 128:
                raise ValueError("Folder name must contain 1..128 characters")
            result["name"] = value["name"].strip()
        if result["kind"] not in ("breakpoints", "scripts"):
            raise ValueError("Folder kind must be breakpoints or scripts")
        if "parentId" in value:
            if value["parentId"] is None:
                result.pop("parentId", None)
            else:
                result["parentId"] = value["parentId"]
        for key in ("enabled", "expanded"):
            if key in value:
                if type(value[key]) is not bool:
                    raise ValueError(f"Folder {key} must be boolean")
                result[key] = value[key]
        if "order" in value:
            if not valid_order(value["order"]):
                raise ValueError("Folder order must be a finite number")
            result["order"] = value["order"]
        folders = [result if item["id"] == folder_id else item for item in service.folders] if existing else [*service.folders, result]
        rules = service.rules
        if "enabled" in value and existing:
            below = descendants(folders, folder_id)
            folders = [{**item, "enabled": value["enabled"]} if item["id"] in below else item for item in folders]
            rules = [{**rule, "enabled": value["enabled"]} if rule.get("folderId") in below | {folder_id} else rule for rule in rules]
        folders = validate_folders([dict(item) for item in folders])
        result = next(item for item in folders if item["id"] == result["id"])
        service.persist_config(rules=ordered_rules(rules, folders), folders=folders)
        return web.json_response(result, status=200 if existing else 201)

    def pending_gate(token):
        gate = service.pending.get(token)
        if not gate or gate["future"].done():
            return None
        return gate

    def stale_gate():
        return web.json_response({"error": {"code": "stale_gate", "message": "Breakpoint is no longer pending"}}, status=409)

    def checked_gate_edit(gate, value, *, require_flow=False):
        if not isinstance(value, dict):
            raise ValueError("Edited value must be an object")
        if gate["value"].get("bodyUnavailable") and any(
                value.get(key, gate["value"].get(key, "")) != gate["value"].get(key, "")
                for key in ("body", "bodyBase64")):
            raise ValueError("Body editing is unavailable for streamed messages; edit only headers and status.")
        from .service import apply_message
        from .sse import serialize
        if gate["stage"] == "event":
            return serialize(gate["value"]), serialize(value)
        flow = service.flows.get(gate["recordId"])
        if not flow:
            if require_flow:
                raise web.HTTPConflict(reason="Breakpoint connection is no longer active")
            return None, None
        request_edit = gate["stage"] == "request"
        message = flow.request if request_edit else flow.response
        edited = copy.deepcopy(message)
        from .large_body import CAPTURE_KEY, apply_streamed_headers
        if not request_edit and CAPTURE_KEY in flow.metadata:
            apply_streamed_headers(edited, value)
        else:
            headers_only = (bool(gate["value"].get("bodyUnavailable")) or gate["recordId"] in service.streams
                            or (not request_edit and "text/event-stream" in message.headers.get("content-type", "").lower()))
            apply_message(edited, value, request_edit, headers_only=headers_only)
        return message, edited

    def body_summary(body):
        if body is None:
            return {"available": False}
        sample = body[:4096].decode("utf-8", errors="replace")[:1000]
        return {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                "textPreview": sample if "\x00" not in sample and "\ufffd" not in sample else None,
                "previewTruncated": len(body) > len(sample.encode("utf-8"))}

    def response_changes(original, edited):
        names = dict.fromkeys(name.lower() for name in (*original.headers.keys(), *edited.headers.keys()))
        changed = [name for name in names if original.headers.get_all(name) != edited.headers.get_all(name)]
        headers = []
        for name in sorted(changed, key=lambda item: item not in {"location", "refresh"})[:12]:
            values = edited.headers.get_all(name)
            preview = [value[:512] for value in values[:2]]
            headers.append({"name": name[:160], "values": preview,
                            "truncated": len(name) > 160 or len(values) > len(preview) or any(len(value) > 512 for value in values[:2])})
        return {"status": [original.status_code, edited.status_code], "headers": headers,
                "omittedHeaders": max(0, len(changed) - len(headers)),
                "body": body_summary(edited.raw_content) if original.raw_content != edited.raw_content else "unchanged"}

    def gate_approval(gate_token, gate, value, original, edited):
        if original is None:
            return None
        if gate["stage"] == "event":
            if original == edited:
                return None
            detail = {"kind": "event", "changes": body_summary(edited)}
        elif gate["stage"] == "request":
            origin = (original.scheme, original.host, original.port)
            target = (edited.scheme, edited.host, edited.port)
            if origin == target:
                return None

            def server_name(address):
                scheme, host, port = address
                host = f"[{host}]" if ":" in host else host
                return f"{scheme}://{host}:{port}"

            detail = {"kind": "redirect", "sourceServer": server_name(origin), "server": server_name(target)}
        else:
            if (original.status_code, original.headers.fields, original.raw_content) == (
                    edited.status_code, edited.headers.fields, edited.raw_content):
                return None
            detail = {"kind": "response", "changes": response_changes(original, edited)}
        stamp = json.dumps([gate_token, detail, value], sort_keys=True, separators=(",", ":")).encode()
        return {**detail, "stamp": hashlib.sha256(stamp).hexdigest()}

    async def pending_approval(request):
        token = request.match_info["token"]
        value = await request.json()
        gate = pending_gate(token)
        if gate is None:
            return stale_gate()
        original, edited = checked_gate_edit(gate, value, require_flow=True)
        return web.json_response({"approval": gate_approval(token, gate, value, original, edited)})

    async def resume(request):
        token = request.match_info["token"]
        decision = await request.json()
        gate = pending_gate(token)
        if gate is None:
            return stale_gate()
        if decision.get("action") == "drop":
            flow = service.flows.get(gate["recordId"])
            if flow:
                flow.kill()
            gate["future"].set_exception(ConnectionError("Dropped by user"))
        elif decision.get("action") == "continue":
            value = decision.get("value", gate["value"])
            if not isinstance(value, dict):
                raise ValueError("Edited value must be an object")
            if decision.get("decoded") is not None:
                from .codecs import prepare_decoded
                value = await prepare_decoded(service, gate, decision["decoded"], value)
                if pending_gate(token) is not gate:
                    return stale_gate()
            mcp_edit = decision.get("mcp") is True and "value" in decision
            original, edited = checked_gate_edit(gate, value, require_flow=mcp_edit)
            if mcp_edit:
                approval = gate_approval(token, gate, value, original, edited)
                if approval:
                    supplied = decision.get("approval")
                    expected = hmac.digest(mcp_approval_key, approval["stamp"].encode(), "sha256").hex() if mcp_approval_key else ""
                    if not isinstance(supplied, str) or len(supplied) != 64 or not hmac.compare_digest(supplied.encode(), expected.encode()):
                        return web.json_response({"error": {"code": "approval_required", "message": "Approve this breakpoint edit before continuing"}}, status=403)
            gate["future"].set_result(value)
        else:
            raise ValueError("action must be continue or drop")
        return web.json_response({"ok": True})

    async def delete(request):
        record_id, device = request.match_info.get("id"), request.query.get("device")
        ids = [key for key, value in service.records.items() if (not record_id or key == record_id) and (not device or (value.get("deviceId") or value["device"]) == device)]
        for key in ids:
            service.forget_record(key)
        service.db.commit()
        service.changed()
        return web.json_response({"deleted": len(ids)})

    async def export(request):
        item = service.records.get(request.match_info["id"])
        if item is None:
            raise web.HTTPNotFound()
        fmt = request.query.get("format", "request")
        if item.get("kind") == "tunnel":
            raise ValueError("SSL inspection is required to export HTTP contents from an encrypted tunnel")
        exported_stage = "request" if fmt == "curl" else fmt
        if exported_stage in ("request", "response") and (item.get(exported_stage) or {}).get("bodyUnavailable"):
            raise ValueError("Full body export is unavailable because this message was streamed without retaining its body.")
        if fmt == "curl":
            value = item["request"]
            parts = ["curl", "-X", shlex.quote(value["method"]), shlex.quote(value["url"])]
            for key, val in value["headers"]:
                if key.lower() not in ("content-length", "host", "transfer-encoding"):
                    parts.extend(["-H", shlex.quote(f"{key}: {val}")])
            import base64
            raw = base64.b64decode(value["bodyBase64"])
            prefix = ""
            if raw:
                if b"\x00" in raw or raw.decode("utf-8", "replace").encode("utf-8") != raw:
                    prefix = "printf %s " + shlex.quote(value["bodyBase64"]) + " | base64 --decode | "
                    parts.extend(["--data-binary", "@-"])
                else:
                    parts.extend(["--data-binary", shlex.quote(raw.decode("utf-8"))])
            return web.Response(text=prefix + " ".join(parts), content_type="text/plain", headers={"Content-Disposition": f'attachment; filename="{item["id"]}.sh"'})
        if fmt not in ("request", "response", "events"):
            raise ValueError("Unknown export format")
        value = exported(item).get("events") if fmt == "events" else item.get(fmt)
        return web.Response(text=json.dumps(value, ensure_ascii=False, indent=2), content_type="application/json", headers={"Content-Disposition": f'attachment; filename="{item["id"]}-{fmt}.json"'})

    async def export_all(request):
        # Retain the starting set; stream one capture at a time instead of a second full-session copy.
        records = sorted(service.records.values(), key=lambda item: item["startedAt"])
        header = {"format": "streamglass-session", "version": 1,
                  "exportedAt": datetime.now(timezone.utc).isoformat(), "recordCount": len(records)}
        response = web.StreamResponse(headers={"Content-Type": "application/json; charset=utf-8",
                                               "Cache-Control": "no-store",
                                               "Content-Disposition": 'attachment; filename="streamglass-session.json"'})
        if origin := request.headers.get("Origin"):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        await response.prepare(request)
        await response.write((json.dumps(header)[:-1] + ', "records": [\n').encode())
        for index, record in enumerate(records):
            value = ((",\n" if index else "") + json.dumps(exported(record), ensure_ascii=False)).encode()
            for offset in range(0, len(value), 64 * 1024):
                await response.write(value[offset:offset + 64 * 1024])
        await response.write(b"\n]}\n")
        await response.write_eof()
        return response

    async def certificate(request):
        path = service.directory / "mitmproxy" / "mitmproxy-ca-cert.pem"
        if not path.is_file():
            raise web.HTTPNotFound(text="CA is not ready")
        return web.FileResponse(path, headers={"Content-Disposition": 'attachment; filename="streamglass-ca.pem"'})

    async def websocket(request):
        socket = web.WebSocketResponse(heartbeat=30, max_msg_size=4096)
        await socket.prepare(request)
        service.sockets.add(socket)
        try:
            await socket.send_json({"type": "state", "data": service.state()})
            async for message in socket:
                pass
        finally:
            service.sockets.discard(socket)
        return socket

    app.add_routes([web.get("/api/state", state), web.get("/api/pending", pending), web.get("/api/workspace-config", workspace_config), web.put("/api/workspace-config", workspace_config), web.get("/api/traffic-tools", traffic_tools), web.put("/api/traffic-tools", traffic_tools), web.post("/api/records/{id}/pin", pin), web.get("/api/search", search), web.get("/api/records/{id}", record), web.get("/api/records/{id}/fields", record_fields),
                    web.put("/api/settings", settings), web.post("/api/mcp/tls-patterns", mcp_tls_patterns), web.post("/api/wake", wake), web.post("/api/lan-devices", lan_device), web.put("/api/rules", rules),
                    web.post("/api/folders", folder), web.patch("/api/folders/{id}", folder), web.delete("/api/folders/{id}", folder),
                    web.post("/api/pending/{token}/approval", pending_approval),
                    web.post("/api/pending/{token}", resume), web.delete("/api/records", delete),
                    web.delete("/api/records/{id}", delete), web.get("/api/export/{id}", export),
                    web.get("/api/export-all", export_all), web.get("/api/certificate", certificate), web.get("/api/ws", websocket)])
    from .lab import routes as lab_routes
    lab_routes(app, service)
    from .codecs import install as install_codecs
    install_codecs(app, service)
    from .productivity import install as install_productivity
    from .capture_sessions import install as install_sessions
    from .repeat_replay import install as install_repeat
    install_productivity(app, service)
    install_sessions(app, service)
    install_repeat(app, service)
    return app

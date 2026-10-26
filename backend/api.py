import asyncio
import copy
import hmac
import json
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

from .service import MAX_BODY, is_sse
from .sse import exported
from .sse_status import sse_status
from .search import search as search_records


def create_app(service):
    @web.middleware
    async def boundary(request, handler):
        origin = request.headers.get("Origin")
        allowed = {"app://streamglass", "http://127.0.0.1:5173", "http://localhost:5173", f"http://127.0.0.1:{service.port}", f"http://localhost:{service.port}"}
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
        if request.path == "/api/ws":
            supplied = request.query.get("token", supplied)
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
        if isinstance(changes, dict) and "running" in changes:
            changes["proxyEnabled"] = changes.pop("running")
        if not isinstance(changes, dict) or set(changes) - {"capturePaused", "proxyEnabled", "proxyPort", "listenHost", "tlsDomains"}:
            raise ValueError("Unknown settings")
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
            from .repeat_replay import stop_jobs
            await stop_jobs(service)
            if service.master:
                for flow_id, flow in list(service.flows.items()):
                    flow.kill()
                    service.cancel(flow_id, "Proxy stopped by user")
                service.streams.clear()
                service.flows.clear()
                await service.master.addons.get("proxyserver").servers.update([])
                service.master.shutdown()
                await service.proxy_task
                service.master = None
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
        service.persist_config()
        return web.json_response({**service.state()["settings"], "interruptedConnections": interrupted})

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
        rules = validate_rules(value["rules"], service.folders)
        service.persist_config(rules=rules)
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
        ids, names = set(), set()
        for item in folders:
            if not isinstance(item, dict) or set(item) != {"id", "name", "kind"}:
                raise ValueError("Expected folder id, name and kind")
            if not isinstance(item["id"], str) or not item["id"] or len(item["id"]) > 256 or item["id"] in ids:
                raise ValueError("Folder IDs must be unique strings")
            if item["kind"] not in ("breakpoints", "scripts") or not isinstance(item["name"], str) or not item["name"].strip() or len(item["name"].strip()) > 128:
                raise ValueError("Invalid folder name or kind")
            item["name"] = item["name"].strip()
            key = (item["kind"], item["name"].casefold())
            if key in names:
                raise ValueError("Folder name already exists")
            ids.add(item["id"])
            names.add(key)
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
        service.productivity_revision += 1
        return web.json_response(snapshot())

    async def folder(request):
        folder_id = request.match_info.get("id")
        existing = next((item for item in service.folders if item["id"] == folder_id), None)
        if folder_id and existing is None:
            raise web.HTTPNotFound(text="Folder not found")
        if request.method == "DELETE":
            rules = [{key: value for key, value in rule.items() if key != "folderId"} if rule.get("folderId") == folder_id else rule for rule in service.rules]
            service.persist_config(rules=rules, folders=[item for item in service.folders if item["id"] != folder_id])
            return web.json_response({"ok": True})
        value = await request.json()
        allowed = {"name"} if existing else {"name", "kind"}
        if not isinstance(value, dict) or set(value) != allowed:
            raise ValueError("Expected folder name" if existing else "Expected folder name and kind")
        name = value["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 128:
            raise ValueError("Folder name must contain 1..128 characters")
        name = name.strip()
        kind = existing["kind"] if existing else value["kind"]
        if kind not in ("breakpoints", "scripts"):
            raise ValueError("Folder kind must be breakpoints or scripts")
        if any(item["id"] != folder_id and item["kind"] == kind and item["name"].casefold() == name.casefold() for item in service.folders):
            raise ValueError("Folder name already exists")
        result = {"id": folder_id or str(uuid.uuid4()), "name": name, "kind": kind}
        folders = [result if item["id"] == folder_id else item for item in service.folders] if existing else [*service.folders, result]
        service.persist_config(folders=folders)
        return web.json_response(result, status=200 if existing else 201)

    async def resume(request):
        gate = service.pending.get(request.match_info["token"])
        if not gate or gate["future"].done():
            return web.json_response({"error": {"code": "stale_gate", "message": "Breakpoint is no longer pending"}}, status=409)
        decision = await request.json()
        if decision.get("action") == "drop":
            flow = service.flows.get(gate["recordId"])
            if flow:
                flow.kill()
            gate["future"].set_exception(ConnectionError("Dropped by user"))
        elif decision.get("action") == "continue":
            value = decision.get("value", gate["value"])
            if not isinstance(value, dict):
                raise ValueError("Edited value must be an object")
            if gate["value"].get("bodyUnavailable") and any(
                    value.get(key, gate["value"].get(key, "")) != gate["value"].get(key, "")
                    for key in ("body", "bodyBase64")):
                raise ValueError("Body editing is unavailable for streamed messages; edit only headers and status.")
            if decision.get("decoded") is not None:
                from .codecs import prepare_decoded
                value = await prepare_decoded(service, gate, decision["decoded"], value)
                if service.pending.get(request.match_info["token"]) is not gate or gate["future"].done():
                    raise web.HTTPConflict(reason="Breakpoint is no longer pending")
            from .service import apply_message
            from .sse import serialize
            flow = service.flows.get(gate["recordId"])
            if gate["stage"] == "event":
                serialize(value)
            elif flow:
                message = flow.request if gate["stage"] == "request" else flow.response
                from .large_body import CAPTURE_KEY, apply_streamed_headers
                if gate["stage"] == "response" and CAPTURE_KEY in flow.metadata:
                    apply_streamed_headers(copy.deepcopy(message), value)
                else:
                    apply_message(copy.deepcopy(message), value, gate["stage"] == "request", headers_only=bool(gate["value"].get("bodyUnavailable")) or gate["recordId"] in service.streams or (gate["stage"] == "response" and "text/event-stream" in flow.response.headers.get("content-type", "").lower()))
            gate["future"].set_result(value)
        else:
            raise ValueError("action must be continue or drop")
        return web.json_response({"ok": True})

    async def delete(request):
        record_id, device = request.match_info.get("id"), request.query.get("device")
        ids = [key for key, value in service.records.items() if (not record_id or key == record_id) and (not device or value["device"] == device)]
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

    app.add_routes([web.get("/api/state", state), web.get("/api/pending", pending), web.get("/api/workspace-config", workspace_config), web.put("/api/workspace-config", workspace_config), web.get("/api/traffic-tools", traffic_tools), web.put("/api/traffic-tools", traffic_tools), web.post("/api/records/{id}/pin", pin), web.get("/api/search", search), web.get("/api/records/{id}", record),
                    web.put("/api/settings", settings), web.put("/api/rules", rules),
                    web.post("/api/folders", folder), web.patch("/api/folders/{id}", folder), web.delete("/api/folders/{id}", folder),
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

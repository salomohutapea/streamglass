# Contracts for new features

These are current constraints and extension guidance, not a second API specification. Use [architecture](ARCHITECTURE.md), [workflows](WORKFLOWS.md), and [MCP](MCP.md) for existing behavior and payload examples. Last source review: 2026-10-18.

## Ownership and communication

| Boundary | Owner and rule |
| --- | --- |
| Traffic forwarding and retained records | Python engine; React and MCP must not implement independent forwarding behavior |
| Management API | `backend/api.py`; authenticated loopback access, validated inputs, bounded responses |
| Desktop privileges | `electron/main.mjs` and narrow `electron/preload.cjs` methods; never expose arbitrary shell or filesystem APIs |
| Scripts | QuickJS worker via `electron/script-service.mjs`; keep runtime/resource limits and output validation |
| MCP | `electron/mcp-tools.mjs` adapts to the same management API; `mcp-server.mjs` owns authenticated transports |
| Presentation and editor drafts | React; the engine remains authoritative about whether a gate is pending |

When adding an operation, trace it through the management route, service mutation, persisted configuration, renderer contract, and relevant MCP tool. Expose suitable traffic operations through MCP; OS certificate installation and unrestricted local file access are not part of the current MCP boundary.

## Forwarding is different from retention

- Opaque HTTPS tunnels expose destination metadata, not endpoints, status codes, bodies, or SSE events. Their CONNECT status is not an origin API response status.
- Enabling SSL inspection affects new connections after existing matching opaque tunnels are interrupted. Never relabel historical encrypted records as decrypted requests.
- TLS inspection does not decrypt application-level encrypted payloads. Preserve those bytes and allow raw text/base64 views where available.
- Capture limits and preview pagination must not silently truncate bytes sent to the client. Mark missing retained content explicitly in views and exports.
- Compressed bodies must be decoded for inspection with a bounded output. A small wire body can expand beyond the retention budget; mark it incomplete instead of storing or displaying an unbounded decoded body. This capture limit must not change forwarded bytes.
- Do not buffer an entire long-lived SSE response to implement search, export, throttling, or a new viewer.
- Preserve duplicate headers using header pairs. Keep content encoding and length consistent when applying edits; reuse current mutation helpers.

## Pause, rules, and gates

Scripts run before the matching breakpoint presents the resulting message. Request, response, and event stages have distinct edit capabilities: an event cannot change HTTP status or headers already sent.

**Pause capture and rules** is pass-through: no new capture, breakpoints, or scripts. Waiting gates release their original values and unsent transformations are discarded. Already-transmitted edits cannot be undone. Requests begun paused and streams switched to pass-through retain that mode until completion. **Stop Proxy** instead interrupts traffic.

Map Local and network conditions also honor pause. An unsent mapped response returns to the origin path when pause releases its response gate; network waits are cancelled. Do not add a separate toggle that appears paused while an engine tool still alters traffic.

Gate tokens are the authority for Continue/Drop. Reject stale or duplicate resolutions, including concurrent UI/MCP submissions. Continue should apply the current validated draft, support Command+Enter, and close the editor after success. Validation failures must leave the editor open with its draft intact. Closing the editor alone is not a resolution.

The inspector stays read-only; edits use detached windows. Request context remains available beside response/event editing, and prior SSE events remain read-only and copyable.

## SSE and body handling

Use `backend/sse.py` and the async integration in `backend/engine.py`. The latter checks the pinned mitmproxy implementation; dependency upgrades require explicit compatibility work rather than bypassing that check.

Preserve incremental UTF-8 and line framing, event order, multiline data, comments, IDs, retry fields, supported compression, and incomplete EOF behavior. An untouched event should keep its original wire bytes. A retained event is not proof that the entire response has completed.

Large REST responses and oversized SSE events have different retention/edit policies. Consult the current constants and [large-response guide](WORKFLOWS.md#large-responses); do not duplicate numerical limits in new features. A preview must never become a full replacement body or complete fixture without an explicit completeness check.

## Persistent data and concurrency

The engine owns capture/configuration storage under the selected application-data profile. Add backward-compatible defaults for new fields. Do not reset old profiles, replace the SQLite database, or drop unrelated configuration on upgrade.

UI windows and MCP clients can edit rules concurrently. Follow the existing rule-update path and its concurrency handling. Keep stable rule/folder/flow identities; array position is not a durable identifier.

The rules PUT endpoint replaces the entire rule list and requires the current integer `rulesRevision` from `/api/state`. It returns the new revision. A missing revision is rejected with HTTP 428; a stale revision returns HTTP 409 `revision_conflict`, so the client must reload and reconcile its draft. Editor and MCP mutations fetch current rules before applying a change. Folder mutations and workspace loads also advance the persisted revision when they change the rule list. Do not retry a rejected write blindly or replace another client's changes from a stale snapshot. Folder deletion ungroups contained rules rather than deleting or disabling them.

Pins protect captures from automatic eviction within the existing capture budget. Explicit deletion removes them, and pins do not restore truncated content. Saved-session features must distinguish complete bodies from previews and retain incomplete-capture warnings.

## Verification to design with the change

Build small cases around the affected boundary: malformed API input; stale gate; pause before/during interception; split SSE frame; compressed and large body; restart with older config; two clients updating the same settings. Add only relevant cases and use existing suites from [the agent guide](AGENT_GUIDE.md).

Run builds/tests only when authorized. A source review does not establish successful packaging, certificate trust, device connectivity, or long-duration streaming behavior.

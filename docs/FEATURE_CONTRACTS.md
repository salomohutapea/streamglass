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

## TLS failure diagnostics

When the engine terminates TLS (SSL inspection) and a handshake fails, `tls_failed_client`/`tls_failed_server` record `tlsFailure: {side, reason, at, likelyCause}` on the CONNECT/tunnel record, creating an error tunnel record if none exists (nothing is recorded while capture is paused). `likelyCause` is `untrusted-ca`, `pinning`, `protocol`, or `unknown`; it is a heuristic (client disconnects mid-handshake, or repeated rejections from a device that completed other handshakes, suggest pinning). The table shows a warning badge and a "TLS errors" quick filter; the Overview callout lists per-platform fixes and a button that removes covering patterns from `tlsDomains` through the existing settings API. Diagnostics never change forwarded bytes.

## Pause, rules, and gates

Scripts run before the matching breakpoint presents the resulting message. Request, response, and event stages have distinct edit capabilities: an event cannot change HTTP status or headers already sent.

Breakpoint gates have no timeout. They wait until continued or dropped by the user or MCP, released by pausing capture, or ended by proxy stop, client disconnect or app quit. All pending gates are shown in a single Breakpoints window (oldest first, live wait time); resolving one selects the next, and the window closes once its last gate is resolved. The window must not steal focus when a new gate arrives.

**Pause capture and rules** is pass-through: no new capture, breakpoints, or scripts. Waiting gates release their original values and unsent transformations are discarded. Already-transmitted edits cannot be undone. Requests begun paused and streams switched to pass-through retain that mode until completion. **Stop Proxy** instead interrupts traffic.

Map Local and network conditions also honor pause.Map Remote, Rewrite and Block follow the same rule: nothing applies while paused, and a flow marked pass-through never receives them. Their order is Block, Map Local, Map Remote, request Rewrite, upstream, response Rewrite; response body replacement is limited to complete UTF-8 non-SSE bodies of at most 8 MiB and otherwise forwards the original bytes.  An unsent mapped response returns to the origin path when pause releases its response gate; network waits are cancelled. Do not add a separate toggle that appears paused while an engine tool still alters traffic.

Gate tokens are the authority for Continue/Drop. Reject stale or duplicate resolutions, including concurrent UI/MCP submissions. Continue should apply the current validated draft, support Command+Enter, and close the editor after success. Validation failures must leave the editor open with its draft intact. Closing the editor alone is not a resolution.

The inspector stays read-only; edits use detached windows. Request context remains available beside response/event editing, and prior SSE events remain read-only and copyable. Request/Response tabs add read-only structured views (query, form, multipart, cookies, Set-Cookie, image preview via data URL) with a Structured/Raw toggle; records carry `requestSize`/`responseSize` (decoded bytes, null if unknown) plus `...Encoded` sizes.

## Timing details

`backend/timings.py` stores `record.timings` (epoch milliseconds plus derived durations) when the response hook runs: `requestStart`, `requestSent`, `responseHeaders`, `responseEnd`, upstream `connectStart`/`tcpSetup`/`tlsSetup`, and `connectMs`, `tlsMs`, `requestMs`, `serverMs`, `downloadMs`, `pausedMs`. Missing values are omitted (reused connections have no handshake). `requestSent` is the later of the request hook releasing the request (after rules and breakpoints) and the upstream handshake completing, so breakpoint time never counts as `serverMs` (`responseHeaders - requestSent`); it is reported as `pausedMs` and response-side pauses are removed from `downloadMs`. This is an approximation of the upstream send, not a socket-level measurement. Capture-list summaries carry `serverMs`; the optional Server time column and the Overview Timing waterfall render it with the Duration format. Timings are observational and must not change forwarded data.

SSE events carry `gapMs` (time since the previous event; the first is relative to response headers) and `sseDiagnostics.gapStats` holds `count/minMs/avgMs/p95Ms/maxMs`. The Events view flags gaps over 3x the median (needs 4+ gaps). MCP `get_capture` metadata, `get_capture_events` and `get_sse_diagnostics` expose these fields without new tools.

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

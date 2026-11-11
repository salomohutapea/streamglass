# Contracts for new features

These are current constraints and extension guidance, not a second API specification. Use [architecture](ARCHITECTURE.md), [workflows](WORKFLOWS.md), and [MCP](MCP.md) for existing behavior and payload examples. Last source review: 2026-10-29.

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
- Compressed bodies must be decoded for inspection with a bounded output. A small wire body can expand beyond the retention budget; mark it incomplete instead of storing or displaying an unbounded decoded body. This capture limit must not change forwarded bytes. Compressed SSE streams use the same bounded decoding: Brotli output is requested in steps of at most 64 KiB.
- Do not buffer an entire long-lived SSE response to implement search, export, throttling, or a new viewer.
- Preserve duplicate headers using header pairs. Keep content encoding and length consistent when applying edits; reuse current mutation helpers.

## LAN access and MCP approvals

These controls came from the 2026-10-29 hardening. Keep them when changing proxy or MCP behavior.

- New profiles listen on `127.0.0.1` (`listenHost`); the user opts in to `0.0.0.0` in Settings. MCP is off until enabled; `mcp.json` starts as `{enabled:false, token, approvedRedirects:[]}`. Existing profiles keep stored values.
- `backend/lan_guard.py` owns LAN policy. While LAN access is on, a non-loopback client must be in `settings.lanDevices` (IP addresses), otherwise the connection is refused with `client.error` and recorded as a request in the state summary (`lanRequests`: at most 32, not persisted). Approving writes `lanDevices` through `/api/lan-devices`. An approval lasts `DEVICE_TTL_SECONDS` (7 days) from when it was given: `settings.lanDeviceApprovals` maps address to approval time, `LanGuard.prune` drops expired addresses before every membership check and state summary, and allowing again renews. `settings.lanDeviceExpiry` (default true, a boolean accepted by `/api/settings`) turns this off; turning it back on restarts every device's 7 days. Devices approved before this existed start their 7 days on first prune. `lanDeviceApprovals` is engine-owned and not writable through the settings route; the state summary carries `lanDeviceTtlSeconds`. The main window asks in a modal Device approval popup (oldest request first, Deny focused, Esc denies); it is suppressed while Settings, Connect a device, the welcome tour or the walkthrough is open, and Connect a device shows the same request inline for physical devices. Loopback clients (this Mac, simulators, `10.0.2.2`, `adb reverse`) are never restricted.
- Approved LAN devices cannot reach non-global destinations (loopback, private, link-local, CGNAT, ULA, multicast, reserved) unless matched by `settings.lanAllowedDestinations` (host wildcards, IP addresses or CIDR ranges; `*`, `*.*` and `/0` rejected; at most 100). The `server_connect` hook checks every resolved address and `server_connected` checks the peer actually connected. Do not add a path that connects before these hooks run. Public IPs behind a VPN are not detected.
- The phone setup site answers only a `Host` header that is one of the Mac's LAN IPv4 addresses (421 otherwise) and shows the CA's SHA-256 fingerprint.
- MCP actions that send traffic or widen access wait for an in-app Allow (`requestApproval` in `electron/main.mjs`, `approve` in `electron/mcp-tools.mjs`): Deny is the default, a request is refused after 120 s, and at most 8 can wait. Covered: `replay_request` and `start_replay_job`; newly enabled Map Remote redirect servers (also via `set_traffic_rule_group_enabled` and any traffic-tools edit); `resolve_pending` edits to another scheme/host/port; new `tlsDomains`; new or changed rule JavaScript; `load_workspace`. Approved servers persist as `approvedRedirects` (at most 200). MCP refuses TLS patterns whose last two host labels are not literal; the desktop does not. A new MCP tool that sends traffic, redirects it or unlocks decryption must ask the same way and reuse the engine validators.
- Stopping the proxy listener restores saved Mac system proxy settings that still point at Streamglass, and starting it reapplies them through Mac monitoring.

## TLS failure diagnostics

When the engine terminates TLS (SSL inspection) and a handshake fails, `tls_failed_client`/`tls_failed_server` record `tlsFailure: {side, reason, at, likelyCause}` on the CONNECT/tunnel record, creating an error tunnel record if none exists (nothing is recorded while capture is paused). `likelyCause` is `untrusted-ca`, `pinning`, `protocol`, or `unknown`; it is a heuristic (client disconnects mid-handshake, or repeated rejections from a device that completed other handshakes, suggest pinning). The table shows a warning badge and a "TLS errors" quick filter; the Overview callout lists per-platform fixes and a button that removes covering patterns from `tlsDomains` through the existing settings API. Diagnostics never change forwarded bytes.

## Pause, rules, and gates

Scripts run before the matching breakpoint presents the resulting message. Request, response, and event stages have distinct edit capabilities: an event cannot change HTTP status or headers already sent.

Breakpoint gates have no timeout. They wait until continued or dropped by the user or MCP, released by pausing capture, or ended by proxy stop, client disconnect or app quit. All pending gates are shown in a single Breakpoints window (oldest first, live wait time); resolving one selects the next, and the window closes about 2.5 seconds after its last gate is resolved if no new gate arrives. A gate whose flow ends in an error without being resolved there (typically the client or server disconnecting on its own timeout) stays in the list in its place, marked Disconnected, and stays selected if it was being edited. Its editor keeps the draft read-only under a warning that states how long it was paused, the reason, and that the request can no longer be sent or the device can no longer receive the response or event. Continue and Drop are replaced by Dismiss and no resolve call is made for that token; the window closes only after such entries are dismissed. This is renderer state only: the engine remains the authority on what is pending. The window must not steal focus when a new gate arrives.

**Pause capture and rules** is pass-through: no new capture, breakpoints, or scripts. Waiting gates release their original values and unsent transformations are discarded. Already-transmitted edits cannot be undone. Requests begun paused and streams switched to pass-through retain that mode until completion. **Stop Proxy** instead interrupts traffic.

Map Local and network conditions also honor pause.Map Remote, Rewrite and Block follow the same rule: nothing applies while paused, and a flow marked pass-through never receives them. Their order is Block, Map Local, Map Remote, request Rewrite, upstream, response Rewrite; response body replacement is limited to complete UTF-8 non-SSE bodies of at most 8 MiB (compressed bodies are decoded with the bounded decoder, and the decoded size counts) and otherwise forwards the original bytes.  An unsent mapped response returns to the origin path when pause releases its response gate; network waits are cancelled. Do not add a separate toggle that appears paused while an engine tool still alters traffic.

Gate tokens are the authority for Continue/Drop. Reject stale or duplicate resolutions, including concurrent UI/MCP submissions. Continue should apply the current validated draft, support Command+Enter, and close the editor after success. Validation failures must leave the editor open with its draft intact. Closing the editor alone is not a resolution.

The inspector stays read-only; edits use detached windows. Request context remains available beside response/event editing, and prior SSE events remain read-only and copyable. Request/Response tabs add read-only structured views (query, form, multipart, cookies, Set-Cookie, image preview via data URL) with a Structured/Raw toggle; records carry `requestSize`/`responseSize` (decoded bytes, null if unknown) plus `...Encoded` sizes.

## Timing details

`backend/timings.py` stores `record.timings` (epoch milliseconds plus derived durations) when the response hook runs: `requestStart`, `requestSent`, `responseHeaders`, `responseEnd`, upstream `connectStart`/`tcpSetup`/`tlsSetup`, and `connectMs`, `tlsMs`, `requestMs`, `serverMs`, `downloadMs`, `pausedMs`. Missing values are omitted (reused connections have no handshake). `requestSent` is the later of the request hook releasing the request (after rules and breakpoints) and the upstream handshake completing, so breakpoint time never counts as `serverMs` (`responseHeaders - requestSent`); it is reported as `pausedMs` and response-side pauses are removed from `downloadMs`. This is an approximation of the upstream send, not a socket-level measurement. Capture-list summaries carry `serverMs`; the optional Server time column and the Overview Timing waterfall render it with the Duration format. Timings are observational and must not change forwarded data.

SSE events carry `gapMs` (time since the previous event; the first is relative to response headers) and `sseDiagnostics.gapStats` holds `count/minMs/avgMs/p95Ms/maxMs`. The Events view flags gaps over 3x the median (needs 4+ gaps). MCP `get_capture` metadata, `get_capture_events` and `get_sse_diagnostics` expose these fields without new tools.

SSE connection status comes from `backend/sse_status.py`: `connecting`, `open` and `streaming` while live, then one of `server-closed`, `client-closed`, `server-dropped`, `stream-reset`, `proxy-closed` or `error`. When a stream ends, the engine stores `sseDiagnostics.endReason` as that code, `endDetail` as the original message, and `endedAt`, once. Capture rows and `/api/records/{id}` add `sseStatus`. mitmproxy's error text is the only source of the end side; HTTP/2 resets read "reset by client" from either peer, so only a CANCEL reset counts as the client. Streamglass marks a flow `proxy-closed` before killing it. Older captures keep the raw message in `endReason` and are classified when read.

## SSE and body handling

Use `backend/sse.py` and the async integration in `backend/engine.py`. The latter checks the pinned mitmproxy implementation; dependency upgrades require explicit compatibility work rather than bypassing that check.

Preserve incremental UTF-8 and line framing, event order, multiline data, comments, IDs, retry fields, supported compression, and incomplete EOF behavior. An untouched event should keep its original wire bytes. A retained event is not proof that the entire response has completed.

Large REST responses and oversized SSE events have different retention/edit policies. Consult the current constants and [large-response guide](WORKFLOWS.md#large-responses); do not duplicate numerical limits in new features. A preview must never become a full replacement body or complete fixture without an explicit completeness check.

## Persistent data and concurrency

The engine owns capture/configuration storage under the selected application-data profile. Add backward-compatible defaults for new fields. Do not reset old profiles, replace the SQLite database, or drop unrelated configuration on upgrade.

UI windows and MCP clients can edit rules concurrently. Follow the existing rule-update path and its concurrency handling. Keep stable rule/folder/flow identities; array position is not a durable identifier.

`/api/state` rows carry no icon data; icons are in `applicationIcons`, keyed by application id. A mutation that changes a row must go through `Service.save()` or call `changed()`, because rows are cached per revision and the poll etag relies on it. `/api/records/{id}?compact=1` omits `raw` and `rawBase64` from events, so exports and MCP read the full record instead. With `since`, `/api/state` returns `delta: true`, the changed `rows` and the full `ids` order instead of `records`. Retained events are append-only: code that appends must save, and code that removes events must shorten the list, which rewrites the stored rows. Custom fields follow the same rule: a state row carries `fields` only when a configured field matches, `productivity.fields` in the state summary is the field count, `GET/PUT /api/productivity` uses `fields` (not `watches`), and `/api/analysis` rows carry `fields`. Row values are filled in asynchronously by a background worker, capped at 256 characters, with `summaries` (`[N items]`, `{N keys}`) for arrays and objects; `GET /api/records/{id}/fields` returns one capture's values up to 64 KiB each. Extraction is read-only and never alters forwarded traffic.

The rules PUT endpoint replaces the entire rule list and requires the current integer `rulesRevision` from `/api/state`. It returns the new revision. A missing revision is rejected with HTTP 428; a stale revision returns HTTP 409 `revision_conflict`, so the client must reload and reconcile its draft. Editor and MCP mutations fetch current rules before applying a change. Folder mutations and workspace loads also advance the persisted revision when they change the rule list. Do not retry a rejected write blindly or replace another client's changes from a stale snapshot. Folder deletion moves the folder's rules and sub-folders up one level rather than deleting or disabling them.

Rule folders form a tree per kind (`backend/rule_folders.py`): a folder may carry `parentId` (same kind, no cycles, at most 8 levels), `enabled`, `expanded` and a numeric `order`; rules may carry `order`. Names are unique among siblings. Siblings, rules and folders together, sort by `order` (items without one keep their stored position, folders first), and every rules or folder write stores the rule list in that tree order, because list order is the order rules are tried in. `PATCH /api/folders/{id}` accepts any of `name`, `parentId` (null for the top level), `enabled`, `expanded`, `order`; setting `enabled` also sets every rule and folder below it in the same write. A folder's own `enabled` is a saved switch, not a gate: matching still reads each rule's `enabled`. Existing clients that send only `name`, and the MCP folder tools, are unchanged. `frontend/src/rule-tree.mjs` mirrors the ordering for display and computes drop positions.

Captures of TLS-allowlisted (inspected) domains have their own budget of 5000 captures and `settings.inspectedStorageMiB` (default 1024, accepted 256–4096; Settings → Storage), separate from the 1000 captures and 256 MiB for other traffic, so other traffic never evicts them. Both evict the oldest unpinned capture first, and retention never truncates forwarded data. Pins protect captures from automatic eviction within the existing capture budget. Explicit deletion removes them, and pins do not restore truncated content. Saved-session features must distinguish complete bodies from previews and retain incomplete-capture warnings.

## Verification to design with the change

Build small cases around the affected boundary: malformed API input; stale gate; pause before/during interception; split SSE frame; compressed and large body; restart with older config; two clients updating the same settings. Add only relevant cases and use existing suites from [the agent guide](AGENT_GUIDE.md).

Run builds/tests only when authorized. A source review does not establish successful packaging, certificate trust, device connectivity, or long-duration streaming behavior.

## Content-type quick filters

The row summary includes bounded `requestContentType` and `responseContentType`
strings, normalized from captured Content-Type headers; it adds no body or full
header arrays to snapshots. JSON/Form/XML/JS/CSS/Document/Media/Other filters use
these values. Form may match the request independently of the response type;
opaque tunnels do not match content categories. Each group is OR, groups compose
with AND, and All resets only the quick-filter groups. Saved views carry optional
`contentTypes` through backend validation, Tools IPC and MCP; absence in an older
saved view means no content-type constraint. These filters never change forwarding.

JSON also includes SSE streams once any retained event data parses as JSON,
including while streaming. `hasJsonEvents` is a derived snapshot boolean, cached
per append-only retained event history and cleared on capture removal. It is
recomputed from retained events after restart, not trusted from persisted input.
Blank events, plain text, malformed JSON and [DONE] alone do not match. Detection
is bounded to 1,048,576 characters per event and does not change event forwarding.

## Rule-list and tool-navigation search

Search is display-only and runs locally over the already loaded rules or static
tool navigation. It must preserve rule IDs, original order, folder assignment,
enabled state, server revisions and unsaved editor drafts. The selected folder
scopes rule results. Rule actions still receive the original full rule object.
Older and newly added rules enter results on the next normal state refresh.
Tool navigation search must not switch sections until the user selects a result
or presses Enter. No search query is sent to the backend or saved in workspaces.
Cmd/Ctrl+F within Monaco retains its editor Find behavior rather than focusing
the Tools navigation search.

## Traffic column sizing

Dragging a column title before or after another title reorders the visible columns;
Option+Left/Right on the focused title moves it one position. Column widths and
the active row sort stay attached to their column identities. Order uses the
existing local column preference. Clicking a title still sorts rows; dragging
does not change the row sort. A drop marker shows the insertion edge.

Dragging or keyboard-resizing a column separator changes only the column to its
left, including Request. Separators appear only between data columns, never after
the last data column. Other visible widths are held
at their current sizes; later columns move without resizing. Double-click resets
only that column. Widths remain local preferences, bounded to 48–900 CSS pixels.
An empty trailing area fills unused pane width so row borders, hover and selection
extend to the right edge without stretching data columns. Row actions remain at
the right edge. When columns and actions exceed the pane width, the table scrolls
horizontally inside the traffic pane.
Request context menus remember the table scroll position at opening: an already
queued scroll event at that position leaves the menu open, while later movement
closes it. The text-filter controls wrap when needed to keep the input usable in
narrow panes; the content-type quick-filter strip remains a single row.

## Inspector orientation transition

The Right/Below buttons and equivalent menu commands share one position handler.
Manual changes may use native view-transition snapshots, without replacing the
live pane nodes or changing selected capture, body/editor data, forwarding or
listener state. The sidebar/toolbar are not animated. A superseded queued callback
must not overwrite the latest orientation request. Skipped/unsupported transitions
fall back to the requested position; reduced motion removes the spatial animation.
Narrow windows still force below placement and keep the stored wide-window
preference. Resizing splitters is immediate and does not start this animation.

## Sidebar controls

Devices keep a stable order: a device holds its position for the session regardless of which one sent the latest
request, and a new device is appended (oldest first request first on initial load). Use `stableDeviceOrder` in
`frontend/src/device-labels.mjs`; do not derive display order from record order.

The pin/collapse header button has a full-row hit target even though only its
icon carries pressed styling. Device action buttons use a separate inline group:
hidden buttons occupy no space, and hover or focus within the row reveals the
actions so they remain keyboard-accessible. An active pin remains visible. Device
selection uses its highlight and pressed state rather than an extra check icon.
Application request counts hide while their pin action is visible (hover, keyboard
focus, or an active pin), retaining their layout space to avoid label movement.

## Window chrome zoom and settings routing

`getUiZoom` reads only the invoking window's native WebContents zoom factor.
`onUiZoom` reports native zoom changes and returns an unsubscribe function. Renderer
resize handlers re-read that value without deriving it from window dimensions;
newer native updates supersede older asynchronous reads. Fullscreen chrome and
per-window header insets keep their existing behavior. About windows receive the
same zoom setup as other application windows.

TLS allowlist links (sidebar, connection setup, inspector and SSL footer control)
open HTTPS / TLS. General settings and proxy-port entry points open Proxy. The
settings section is controlled independently of the unsaved settings values, so
section navigation does not discard drafts or save configuration implicitly.

### Packaged layout inspection snapshot

The 2026-10-30 local build `1.1.0-2026-10-30T13-41-59-660Z` was inspected in an
isolated synthetic-data profile. Native page zoom 1 and 1.2 at widths 900, 1100
and 1480 kept the toolbar at 52 physical points. The TLS footer opened HTTPS / TLS,
approved-device icon/text centers matched, the full sidebar hit target unpinned
and collapsed to 48 points, and no device checkmark remained. Inspector motion
reported 260 ms; rapid toggles kept the final request, reduced motion skipped
animation, selection stayed intact, and no renderer errors were observed. This
was packaged UI inspection; no test suites were run. Local evidence is under the
ignored `release/layout-fixes-preview/` directory.

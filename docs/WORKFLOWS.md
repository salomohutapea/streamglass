# Workflows

## Organize the workbench

Use the pin action on a row or its context menu, then open **Pinned** in the sidebar. Separately, applications, devices and domains can be pinned to **Favorites** at the top of the sidebar, and the Filter (⌘⇧F) field at the bottom of the sidebar narrows its lists. While any filter hides requests, a line above the table shows how many are visible and lists every active filter, with Clear all. Pins persist with the capture and protect it from automatic eviction within the bounded capture budget. Explicit delete/clear still removes pinned captures; pinning does not recover previously truncated content.

Choose **Inspector below** or **Inspector on right** from the toolbar or View menu. Both layouts remain resizable and the placement and dimensions persist. The inspector remains read-only.

Right-click a column heading, or use **Choose table columns**, to select Method, Request, Time, Code, Duration, Protocol, Device, Application, Host, Path, and Events. Visible columns persist and their headings support sorting. At least one column remains visible.

Quick filters select HTTP, HTTPS, SSE, or status families 1xx–5xx. Multiple choices within a group are ORed; protocol and status groups combine with AND, alongside search and device/application filters. Encrypted CONNECT records match HTTPS but not origin response status families. SSE can also match HTTPS. These filters change visibility, not capture.

Footer pills show enabled tools and open their controls. **Suspended** indicates traffic-changing tools are paused or the proxy is stopped. Use **Certificate / Setup** in the native menu to open the appropriate Mac, iOS, or Android setup panel directly.

## Map Local

Open **Tools → Map Local** (also available in the native Tools menu). Add a rule, choose its method and URL wildcard, select a response file, and set the status and optional header pairs. Move rules up/down to change priority, then **Save traffic settings**. The first enabled matching rule supplies the response after request rules have run, skipping the origin; response scripts and breakpoints still apply.

Files are imported as snapshots into the local profile, not watched on disk. Choose the file again to update it. The combined decoded fixture-body limit is 32 MiB. HTTPS requires SSL inspection; application-encrypted responses require appropriately encoded fixture bytes. File paths and arbitrary filesystem access are not exposed through MCP.

While any Map Local rule is enabled, active request uploads are buffered up to 8 MiB so scripts can rewrite the URL before matching without leaking a mapped request to the origin. Larger uploads are rejected explicitly. Paused requests bypass Map Local and retain normal pass-through behavior. Large response fixtures still use bounded capture previews. Directory mapping and timed SSE replay are not included.

## Network conditions

Open **Tools → Network Conditioner**. Choose Unrestricted, Slow 3G, 4G, or custom values; set delay in milliseconds and upload/download rates in decimal Kbps (0 means unlimited). Limit the profile by host wildcard and/or device IP, or leave host `*` and device empty to cover inspected proxy traffic. Save to activate it.

Latency is added once per request; transfer limits apply per flow, not as an aggregate device bandwidth budget. Rates are applied progressively to HTTP data, including SSE. The enabled rate profile is selected for new requests. Pause cancels pending artificial delays and bypasses further shaping. No administrator permissions or system-wide network changes are required. This does not simulate packet loss or shape opaque HTTPS tunnels.

## Capture and breakpoints

Start the local proxy and route the intended device or application through it. Captures are stored locally. Pause capture and rules forwards traffic without running breakpoints or scripts. Waiting breakpoints continue with their original, unedited message; unsent script results are discarded. Changes already sent to a server or client cannot be undone. Requests started while paused remain pass-through until completion. An SSE stream switched to pass-through keeps that mode for its remaining lifetime, avoiding parsing halfway through an event; resume applies to new traffic. Stopping the proxy aborts active traffic. A matching breakpoint pauses the request, response, or SSE event until it is resumed, dropped, or released by pausing capture. Breakpoints have no timeout; a client app's own HTTP timeout, or a server or proxy idle timeout, can still end the connection while it waits. If the paused stream queue exceeds 8 MiB, the stream is aborted. Use the per-device delete action to remove that device's captures. Stop the proxy explicitly when finished.

TLS interception is opt-in by domain. Limit it to the domains being inspected. Install Streamglass's local CA only on devices you control and remove its trust when finished. The private CA key stays local and must never be exported. See [device setup](DEVICES.md) for platform-specific steps and limits.

HTTPS connections are listed even when SSL inspection is disabled. These encrypted tunnel rows show the destination host and connection details, not individual API paths or response status codes. Select a row and enable SSL inspection for that domain to inspect future requests. Enabling inspection interrupts existing encrypted connections for newly enabled domains. The client may reconnect automatically; an in-flight request may need to be retried. You do not need to restart the app. Existing tunnel rows remain encrypted and cannot be decrypted retroactively. Request/response/event breakpoints and scripts only apply to inspected HTTP messages, never opaque tunnel bytes.

## Finding and inspecting traffic

Press ⌘F (or the magnifier in the toolbar) to open the filter bar. Choose URL, Request, Response, or SSE events in its first menu, which labels what you are searching, then choose Contains, Does not contain, Equals, Starts with, Ends with, or Wildcard. Matching is case-insensitive; wildcard supports `*` and `?`. Search covers retained content only, and the UI warns when a streamed body or truncated event capture limits coverage.

Click Method, Request, or Time to sort; click the same heading again to reverse direction. Time shows the request start time in your local timezone with milliseconds. SSE requests include `| SSE` beside their HTTP method. The table uses a lock for encrypted connections; response status remains available in the inspector.

Right-click a row (or focus it and press Shift+F10) for exports, a breakpoint, or a JavaScript rule seeded from that row. Encrypted tunnels require inspection before content exports or rules can apply. JSON bodies and event data are formatted with syntax colors and line numbers. Large viewers use Previous/Next pages to keep rendered content bounded, while preserving exact numeric text.

## Rules and scripts

Use New folder in the breakpoint or JavaScript rules window to group rules. The two rule types have separate folder lists. Select a folder before adding a rule, or change an existing rule's Folder field. Rename keeps its assignments; deleting a folder moves its rules to Ungrouped and does not delete them.

Breakpoint rules, JavaScript rules, and paused traffic edits open in separate native windows. All paused traffic appears in one Breakpoints window. Its left list shows every waiting request, response, or SSE event, oldest first, with method, path (host muted), stage, device and a live wait time; select one to edit it with the usual controls. Continue (Command-Enter) or Drop removes it from the list and selects the next oldest. The window closes by itself once the last paused item is handled (a window opened with nothing paused stays open and shows No paused requests). If the app or server gives up while a request is paused (usually its own timeout: OkHttp defaults to 10 seconds), the window stays open and explains which request ended and why; dismiss the notice to let it close. A new breakpoint opens the window if it is closed, but only adds to the list (no focus change, plus a Dock badge) when it is open. Open breakpoint editor in the inspector brings the window forward and selects that gate. Response and SSE event editors show the read-only request alongside the editable content. Closing the window keeps current breakpoints dismissed until you use Open breakpoint editor; the next new breakpoint opens it again. Edits to a gate you switch away from are kept while it is pending, but the decoded-body view is reset. The inspector stays read-only. Right-click a request and choose Add breakpoint… (or Create JavaScript rule…) to open a small window with only that new rule's form, pre-filled with its method and URL; Save or Cancel closes it without showing the rules list. Rule rows show one URL with a method badge and stage labels. Closing the window does not automatically continue pending traffic.

Breakpoint bodies display formatted JSON without changing the original bytes unless you edit the content. Format JSON is also available while editing. SSE editors show earlier retained events in expandable, read-only viewers; select their text and use Command-C or Edit → Copy. Missing or truncated capture history is explicitly labeled.

The macOS menu bar includes Capture, Inspect, and Rules actions, selected-record exports under File, and device setup. Menu availability follows the focused window and selected record. Standard editing and window commands remain native; settings use Command-comma, recording uses Command-Shift-P, and inspector tabs use Command-1 through Command-5.

Rules can match URLs using `*` for any sequence of characters and `?` for one character. A matching rule may run a hook, create a breakpoint, or both. Script hooks receive the matching data and may return an edited object; returning `undefined` uses the supplied object, including in-place edits.

```js
function onRequest(context, url, request) {
  return request;
}

function onResponse(context, url, request, response) {
  return response;
}

function onEvent(context, url, request, event) {
  return event;
}
```

Requests and responses contain headers as `[name, value]` pairs, a text `body`, and `bodyBase64` for the raw bytes. Request objects also include `url` and `method`; response objects include `statusCode`. SSE event objects expose `event`, `data`, `id`, and `retry`. `onEvent` may edit those four fields. Unchanged SSE events retain their original bytes; edited events are serialized again.

Scripts run in a limited QuickJS runtime without Node APIs or network access. A script error fails the matching flow and is shown by the application. SSE interception depends on a version-pinned mitmproxy engine patch; if the expected engine implementation differs, startup refuses the patch. Unsupported content encodings, editing limits, and paused-stream queue limits are reported explicitly.

## Large responses

Large REST responses and responses without a declared length stream to the client with bounded local capture. Streamglass marks the body unavailable for full-body editing/export rather than presenting its preview as a complete response. Status and header breakpoints run before forwarding starts. Body replacements are rejected explicitly on these streamed responses.

SSE events up to 8 MiB can be parsed and presented for event editing; JavaScript hooks also have their own serialized input/output and memory limits. Larger unmodified events switch the remainder of the connection to byte-preserving forwarding, with a visible warning that event capture and editing are no longer active. If a matching event rule requires full-event processing, an oversized event produces an explicit editing-limit error instead of silently skipping the rule.

Reaching the retained SSE capture budget stops retaining later events, not forwarding them. The inspector distinguishes retained events from observed events. Limits protect the local viewer and editor; they are not a promise of unlimited full-body capture or editing.

## Data and security

Captured traffic can contain credentials, cookies, and personal data. Keep the local capture store private and review its contents before exporting; exports contain raw captured data. Streamglass uses a private local CA for TLS interception. Never share its private key. The public certificate may be installed on a selected device; it does not bypass certificate pinning or make an application trust user-installed certificates automatically.


Device labels support a custom name, color, and icon using the pencil beside each device. Automatic icons use platform hints from request user agents; unknown or mixed platforms remain generic. Labels persist locally by device IP. New traffic gets a subtle half-second highlight, disabled with reduced motion.

JSON and text bodies use the same editor as VS Code (Monaco, bundled locally): line numbers, folding, bracket matching, Command-F find, multi-cursor, and native select/copy. Read-only inspectors cannot be edited. Breakpoint body editors are fully editable text with JSON validation squiggles; Command-Return still continues the paused request. Bodies over 2 MB disable folding and bracket matching to stay responsive.

## Applications on this Mac

New local connections are matched to their owning process in the background. The Applications sidebar groups captures by app or executable, shows the local application icon when available, and filters traffic on click. Browser helpers are grouped under their enclosing app bundle; simulator app processes can also be identified. This does not identify apps on a remote phone. Connections that close before lookup, relay processes, or owners unavailable to the current user remain unknown. Old captures are not retroactively assigned. No administrator privilege or native extension is required; app attribution does not wait on the request forwarding path.

## Controls and session export

The toolbar has one Play/Pause capture control. Play starts the listener if needed and resumes capture and rules; Pause keeps traffic passing through without rules. Stop Proxy remains an advanced menu action. Single-capture deletion is immediate. Clearing all captures or an entire device requires confirmation.

Export all captures (toolbar or File menu) writes a JSON session containing the complete retained request/response headers, bodies, SSE events, logs and connection metadata, regardless of current UI filters. The selected capture set is fixed when export begins; active records are serialized as the export progresses and may continue afterward. Existing bodyUnavailable and captureWarning flags remain in the export: data not retained cannot be recovered. Exports stream directly to a temporary file and replace the chosen destination only after a successful transfer.

Headers are collapsed by default, with bodies first, in inspectors and breakpoint windows. Open Headers when needed. Device Setup shows selectable proxy IP and port fields with Copy IP, Copy port and Copy IP:port controls; copied values follow the selected address. Mac/simulator use loopback, while remote devices use a LAN address.

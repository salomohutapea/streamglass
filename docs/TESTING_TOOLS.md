# Testing tools

Open **Tools** in the toolbar. Capture context menus also open Compare, Edit and resend, Save as mock, and Redacted export with that capture selected. See [daily debugging tools](DAILY_TOOLS.md) for saved capture sessions, journeys, watches, assertions, repeated replay, saved views and notes. These tools operate on retained data; they cannot recover bodies or events that were never retained.

## SSE timeline

The inspector's SSE tab starts with a status strip: Connecting → Open (headers received) → Streaming (events arriving) → how the stream ended, each with its time from the request start, and while the stream is open, how long it has been idle. The same status shows as a dot beside **SSE** in the table: pulsing green while live, grey when the server finished it, amber when the client disconnected, the HTTP/2 stream was reset, or Streamglass closed it, and red when the server dropped it or a transport error ended it. "Finished by server" means the server closed the stream cleanly; only the application's own final event can show it considered the stream complete. Below the strip it shows response-header time, first-event time, observed event count/frame bytes, termination reason, and event times, gaps, and delivery state. Times are measured during Streamglass processing, not at the mobile application's event handler; gaps can include time spent paused at earlier breakpoints. They are not origin-only latency measurements. A forwarded event may still be rejected by client parsing or application logic. The table shows the latest 100 retained events; diagnostics can continue counting when retention stops.

## Repeatable scenarios

In **Scenarios**, create a method/URL wildcard rule and choose:

- Context events only: forward named `context` events and suppress other dispatched events.
- Disconnect after N events: terminate the connection after the selected number of events has been sent.
- Delay data events: delay non-`context` events without buffering the whole stream.
- HTTP error once, then normal: supply the configured 4xx/5xx once; later matching requests proceed normally.

Rules start disabled. Save to apply them. The first matching enabled scenario is used; saving scenarios or loading a workspace rearms one-shot behavior. Capture pause bypasses scenarios and cancels artificial waits. These are deliberate tests, not diagnoses of the origin server.

## Map Remote, Rewrite and Block

**Tools → Map Remote**, **Rewrite** and **Block** (also under the Tools menu and the command palette) are ordered lists like Map Local: enable toggle, name, method, URL wildcard (the same matcher as Map Local), move up/down, then save. Each tab saves only its own list; the three lists and Map Local share one revisioned configuration, so a change made in another window or by MCP is reported instead of overwritten.

Order of application for a request: **Block**, then **Map Local**, then (only when Map Local did not answer) **Map Remote**, then request **Rewrite**, then the upstream exchange, then response **Rewrite**. The first matching enabled rule of each type applies, except that every matching request-phase or response-phase Rewrite rule applies in list order. Rules match the URL the client asked for (after any JavaScript rule edits), including after Map Remote has redirected it. Pause capture and rules bypasses all three types.

- **Map Remote** sends matching requests to a fixed `http`/`https` host and port (port 0 is the scheme default), keeping the rest of the path and the query. Optionally replace a path prefix (`/v1` to `/staging/v1`, matched on a segment boundary). The original `Host` header is replaced by the new host unless **Keep the original Host header** is set. **Header overrides** set or remove headers (Authorization, Cookie, X-Session-Id) on redirected requests only, because staging and production usually need different session IDs and tokens. Give each environment's rules a **group** label such as Staging or Production; group chips toggle every rule with that label in the tab, and the MCP tool `set_traffic_rule_group_enabled` toggles them across the three types. Header values are stored in the local profile, so use disposable tokens. Redirect rules do not rewrite request bodies, cookies' domains or absolute URLs inside responses.
- **Rewrite** has a phase. Request rules set or remove request headers. Response rules set or remove response headers, replace the status code (200 to 599), and replace literal text (not a regular expression) in complete UTF-8 bodies. Streamed, SSE, binary, undecodable and bodies over 8 MiB are forwarded unchanged and the capture notes why; forwarded data is never truncated. `Host`, `Content-Length`, `Transfer-Encoding` and other connection-management headers cannot be edited. Map Local and Block responses are not rewritten.
- **Block** returns a synthetic 4xx/5xx response (optional plain-text body) or closes the connection, without contacting the origin. A matching Block rule buffers the request body up to 8 MiB first, and larger uploads are rejected explicitly.

Captures that a rule changed carry `appliedRules` (type, id, name and a short detail), listed in the inspector Overview. The capture shows the request as it was sent, so a Map Remote capture's URL is the redirected URL and the detail shows both. Limits: 100 rules per type, 50 header operations per rule, 64-character group labels.

## Compare two captures

Choose two captures and compare Request, Response, or SSE events. Differences show paths with before/after values; JSON numeric lexemes are preserved, including integers larger than JavaScript's safe integer range. Ignore comma-separated property names or paths, for example `timestamp,id`. Headers compare case-insensitively while keeping duplicate values. SSE can align by sequence or event ID; repeated IDs remain separate occurrences.

Only the first 500 differences are displayed. Incomplete capture warnings prevent an apparent match from being reported as full equality. Large comparisons have an explicit processing budget; an unavailable comparison is not a zero-difference result.

## Capture to mock

**Create mock** creates a disabled Map Local rule from a complete response. Review and enable it in **Tools → Map Local**. A truncated preview is rejected rather than saved as the original response.

For SSE, **Replay SSE with recorded event timing** stores retained transmitted event frames and their measured arrival gaps. It supports up to 10,000 events with at most 60 seconds between events. Comment-only heartbeats and other unretained control frames are omitted; this is an event fixture, not a byte-exact recording of the entire transport. Edited events use their actual forwarded bytes. Timed fixture frames are sent gradually to the client.

## Edit and resend

**Replay** provides an explicit request composer: method, destination URL, headers, and a text/JSON or base64 body. Nothing is sent until **Send request** is clicked. Sending contacts the real destination and may change server data; current interception rules apply. Streamglass derives the Host header from the destination and strips transport headers that must be regenerated.

Base64 mode preserves binary content. Unchanged bodies use their original bytes. If the original body was not fully retained, supply a replacement before sending. A new capture records the replay, including a long-lived SSE response without requiring the composer to wait for its completion.

## Redacted sharing

**Share** previews the exact object to export. Common credential fields are redacted by default; add field names such as `email` or `phone` for your data. Redaction covers query parameters, authentication/cookie headers, nested JSON bodies, and JSON SSE data. Raw/base64 copies and logs are removed so they cannot reintroduce the original content. Unsupported or oversized text content is omitted with a warning.

Inspect the preview before exporting. Field-based redaction cannot recognize every secret or personal value, especially values in arbitrary strings. The original local capture is not changed.

## Configuration workspaces

**Workspaces** stores named configurations: SSL domain allowlist, breakpoint/script rules and folders, Map Local fixtures, network profile, scenarios, codec profiles, and daily analysis/view preferences. Switching automatically saves the current active configuration; the first switch preserves the unsaved configuration as **Previous configuration**. Engine configuration is validated and replaced atomically. Older workspaces without daily preferences load the defaults.

Captures remain in the current session. Saved workspace configurations share a 128 MiB encoded storage budget. Workspaces do not include certificates, CA private keys, MCP credentials, OS proxy settings, listener ports, or codec session keys. Workspace files can still contain sensitive fixture bodies or user-written script source; keep the application-data directory private.

## Optional decoded views and editing

**Codecs** configures URL/bundle-ID matching and decoding. The read-only response inspector offers **Decode response**. Response breakpoint editors offer a decoded view and editing only when the matching codec has re-encoding enabled.

Supported primitives are base64 and AES CBC/CTR with a prepended 16-byte IV, optionally gzip. Custom JavaScript decoder/encoder function expressions run in the existing bounded QuickJS sandbox without filesystem or network access. Functions receive `(body, headers, context)`; `context` includes the URL, direction, and captured request metadata. They return text. Configure both directions explicitly for editing; the request encryption operation is not necessarily the inverse of response decryption.

AES keys are entered locally in a password field and remain in engine memory for that session. They are not written to captures, workspace snapshots, or MCP. Do not embed secrets in custom function source: source is persistent configuration. CBC and CTR do not authenticate plaintext or establish that a key is correct.

On Continue, changed decoded content is encoded and decoded again to check the round trip before release. Failure leaves the breakpoint pending. No-op edits retain the original ciphertext, and nonce/bundle headers are protected. Capture pause forwards the original unsent response. Codec processing is bounded to 4 MiB text and requires complete retained content.

### App-specific protocol boundary

Streamglass does not decode any app's proprietary protocol automatically. Codec profiles only apply the generic base64, AES, gzip, and custom-function transforms you configure. The optional `native64` key-format adapter is a key transformation helper, not an automatic decoder for any app version or platform; a protocol adapter you are authorized to use is needed for full envelope, key, and signature compatibility. A REST codec must not be assumed to apply to every SSE endpoint. Streamglass does not modify or fetch any app's native repositories or runtime crypto artifacts.

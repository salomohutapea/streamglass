# Daily debugging tools

Open **Tools** in the toolbar, or use the native **File → Saved Capture Sessions** and **Tools** menus. On desktop it opens a separate, reusable window, so the traffic table keeps updating and remains interactive while editing settings. Its left-aligned navigation includes Map Local and Network Conditioner alongside daily workflows, test scenarios, comparison, codecs, and configuration workspaces. Drafts are preserved while switching sections. The Tools window does not inherit the main window's full-screen mode.

Opening a capture or applying a saved view focuses the originating traffic window and keeps Tools open. Saved-view creation follows that window's current filters. Browser-only use retains the inline dialog fallback.

## Saved capture sessions

In **Sessions**, name and save the current retained capture set. A snapshot includes requests, response bodies, headers, retained SSE events, timing, notes, and highlights. Captures saved while still active remain incomplete snapshots; saving does not wait for or interrupt their connections.

Open a saved session and choose a capture to read its request, response, or SSE events. Choose a live capture for comparison. Archives are read-only, survive app restarts and clearing live traffic, and do not restore proxy settings, rules, pending breakpoints, certificates, or credentials used to manage Streamglass. Captured application credentials can still be present in headers and bodies.

**Export** and **Import session** use the desktop file picker and stream `.sgsession` files. This version-2 format is newline-delimited JSON: a header with `format`, `version`, `name`, and `recordCount`, followed by one capture per line. It is distinct from the earlier **Export All Captures** JSON document. Imports validate all records before committing a new archive; they do not merge into or overwrite live captures. Imported application icon URLs are removed to prevent external fetches while browsing.

Limits: 64 saved archives, 256 MiB of capture payload per archive, 1 GiB combined, and 1,000 captures per archive. Each imported capture line and its normalized payload must fit the 32 MiB record limit; the file has an additional 64 KiB allowance for archive metadata. Existing retention warnings are preserved. Deleting a saved archive removes that snapshot only; export it first if it should be kept elsewhere.

## Search journeys and waterfall

**Journeys** groups requests that share configured JSON values or correlation headers, within the same device address. Shared aliases connect related requests: an initial response may connect to SSE using `searchId`, with a retry joining through a shared request ID. Requests without evidence of correlation remain separate.

The defaults look for `$.context.searchId`, `$.searchId`, `$.data.searchId`, `x-request-id`, and `x-correlation-id`. Change these in **Correlation settings** to match the API. A repeated or nonunique correlation value can combine unrelated requests; refine the paths or headers if this happens.

The waterfall shows overlapping requests and elapsed time. First data means the first SSE event named `data` marked for forwarding after processing. Optionally configure an inventory JSONPath: the first retained SSE event with a nonempty value at that path marks first inventory. These are proxy observations after scenario/script/breakpoint processing. They do not measure socket delivery, scheduled fixture/rate delays, or client rendering. Older captures fall back to event observation time. App-encrypted bodies remain opaque to these tools.

## JSONPath watches

Add a named watch and choose **Request**, **Response**, or **SSE event**. Watches apply to JSON body content, not headers. Supported syntax includes fields (`$.context.searchId`), quoted keys (`$["a.b"]`), indexes (`$.items[0]`), and wildcards (`$.items[*].id`). Recursive descent and filter expressions are intentionally unsupported.

Watch previews preserve large integer text. Analysis reads at most 4 MiB of JSON per capture and the first 1,000 retained events, expands at most 10,000 values per path, and returns bounded previews. Large, truncated, non-JSON, or encrypted content can produce **unknown**, which is different from a missing field or a passed check. Original bodies and forwarded bytes are unaffected.

## Automatic assertions

Add enabled method/URL wildcard checks in **Assertions**:

- First named SSE event before a deadline measured from response headers.
- Required JSON field in a request, response, or SSE event. `null` counts as an existing field.
- Repeated explicit SSE event IDs.
- Required terminal SSE event before the stream ends.

Assertions evaluate in the background; failed checks appear on traffic rows. The Assertions view and MCP provide individual results: **pass**, **fail**, **pending**, or **unknown**. Checks evaluate the captured representation marked for forwarding and never inject errors or alter traffic. History gaps cannot establish that a terminal event or required value was absent. Time-based checks use post-rule proxy processing time; a pause at a breakpoint can legitimately cause a deadline failure. Older captures without processing timestamps and events with deferred fixture/rate scheduling return unknown for deadline checks.

Preferences are persisted. Results are recomputed from retained captures; they are not a permanent test-results database. A completed connection without a configured terminal event fails that check even if HTTP succeeded.

## Bounded repeated replay

Choose a complete live request in **Repeat**, then configure 1–100 sequential sends, a 0–60-second interval after completion, and a 1–60-second timeout per request. **Start requests** is explicit authorization to send the captured method, destination, headers, and body again. This may change server data, including for requests that appear to be reads. Transport headers are regenerated using the existing replay validator.

One repeat job runs at a time. The result table compares status, duration, observed event count, and errors across iterations; open individual captures and use **Compare** for payload differences. SSE requests count as complete only when their stream ends, so long-lived streams can reach the timeout. Missing request bodies cannot be replayed as empty replacements.

**Cancel repeat** terminates only the job's current connection and prevents later iterations. It cannot undo work already received by the server. Closing the tools window does not cancel a job; the footer pill reopens it. Stopping the proxy or quitting the app stops further sends. Pausing capture bypasses interception rules but does not cancel an explicitly started repeat job. Jobs are session-only and never automatically restart.

## Saved views, notes, and highlights

**Views & notes → Save current filters** stores the search text, content scope, matching mode, HTTP/HTTPS/SSE filters, status-family filters, selected library, device, and application. Apply saved views from the chooser beside the traffic filters. A saved device or application filter can match nothing when that device/app is no longer present.

Right-click a capture and choose **Note and highlight** to add a note or one of five subtle row colors. Choose **None** to remove its highlight. Notes remain separate from the read-only inspector and are included in capture snapshots and exports. Explicit capture deletion removes the associated note. Configuration workspaces also include journey settings, watches, assertions, and saved views; they do not include capture notes or archives.

## Source map

Engine: `backend/productivity.py`, `backend/capture_sessions.py`, `backend/repeat_replay.py`. UI: `frontend/src/DailyTools.tsx`, `daily-tools.mjs`, `LabPanel.tsx`, `App.tsx`. Desktop file transfer: `electron/export-session.mjs`, `main.mjs`, `preload.cjs`. MCP uses the same validated HTTP API.

Regression cases are in `backend/tests/test_daily_tools.py`, `frontend/src/daily-tools.test.mjs`, `tests/mcp-daily-tools.test.mjs`, and `tests/daily-tools-desktop.test.mjs`. The desktop test drives all six workflows with synthetic captures and a real local proxy, including archive export/import and replay cancellation across proxy restarts. Run checks only when authorized by the user.

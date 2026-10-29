# Daily debugging tools

Open **Tools** in the toolbar, or use the native **File → Saved Capture Sessions** and **Tools** menus. On desktop it opens a separate, reusable window, so the traffic table keeps updating and remains interactive while editing settings. Its left-aligned navigation includes Map Local and Network Conditioner alongside daily workflows, test scenarios, comparison, codecs, and configuration workspaces. Drafts are preserved while switching sections. The Tools window does not inherit the main window's full-screen mode. Opening a request from Tools (a journey row, an assertion, a note, a replay or repeat result) shows it in its own inspector window; the main window keeps its selection, and opening the same request again brings that window forward. In a narrow window the section list becomes a scrolling row above the content.

Opening a capture or applying a saved filter focuses the originating traffic window and keeps Tools open. Saving a filter uses that window's current filters. Browser-only use retains the inline dialog fallback.

## Saved capture sessions

In **Sessions**, name and save the current retained capture set. A snapshot includes requests, response bodies, headers, retained SSE events, timing, notes, and highlights. Captures saved while still active remain incomplete snapshots; saving does not wait for or interrupt their connections.

Open a saved session and choose a capture to read its request, response, or SSE events. Choose a live capture for comparison. Archives are read-only, survive app restarts and clearing live traffic, and do not restore proxy settings, rules, pending breakpoints, certificates, or credentials used to manage Streamglass. Captured application credentials can still be present in headers and bodies.

**Export** and **Import session** use the desktop file picker and stream `.sgsession` files. This version-2 format is newline-delimited JSON: a header with `format`, `version`, `name`, and `recordCount`, followed by one capture per line. It is distinct from the earlier **Export All Captures** JSON document. Imports validate all records before committing a new archive; they do not merge into or overwrite live captures. Imported application icon URLs are removed to prevent external fetches while browsing.

Limits: 64 saved archives, 256 MiB of capture payload per archive, 1 GiB combined, and 1,000 captures per archive. Each imported capture line and its normalized payload must fit the 32 MiB record limit; the file has an additional 64 KiB allowance for archive metadata. Existing retention warnings are preserved. Deleting a saved archive removes that snapshot only; export it first if it should be kept elsewhere.

## Search journeys and waterfall

**Journeys** groups requests that share configured JSON values or correlation headers, within the same device address. Shared aliases connect related requests: an initial response may connect to SSE using `searchId`, with a retry joining through a shared request ID. Requests without evidence of correlation remain separate.

The defaults look for `$.context.searchId`, `$.searchId`, `$.data.searchId`, `x-request-id`, and `x-correlation-id`. Change these in **Correlation settings** to match the API. A repeated or nonunique correlation value can combine unrelated requests; refine the paths or headers if this happens.

The waterfall shows overlapping requests and elapsed time. First data means the first SSE event named `data` marked for forwarding after processing. Optionally configure an inventory JSONPath: the first retained SSE event with a nonempty value at that path marks first inventory. These are proxy observations after scenario/script/breakpoint processing. They do not measure socket delivery, scheduled fixture/rate delays, or client rendering. Older captures fall back to event observation time. App-encrypted bodies remain opaque to these tools.

## Custom fields

Highlight the values of specific APIs, such as `searchId` or `journeyIndex`, in the traffic table and inspector. Open **Tools → Daily work → Custom Fields** (**Custom Fields…** in the Tools menu). Each field has a **Name**, shown in the table and inspector, and one to ten **locations** saying where to read it:

- **URL wildcard**, matched against the full URL with the same matcher as assertions, and **Method** (`*` or one method).
- **Read from**: Response body, Request body, SSE events, Response header, or Request header.
- A **JSONPath** for the body and SSE sources, or a **header name** (case-insensitive) for the header sources. Supported JSONPath syntax includes fields (`$.context.searchId`), quoted keys (`$["a.b"]`), indexes (`$.items[0]`), and wildcards (`$.items[*].id`). Recursive descent and filter expressions are intentionally unsupported.

Use several locations when one value lives in different places, for example `searchId` in SSE event data on the stream API and in the response body on the poll API. A capture shows the field when any location matches it, and values from every matching location are merged.

Click a field to edit it; the others collapse to a summary of their locations. **Add field** below the list starts a new one. Drag a field by its card or grip to reorder it (or focus the grip and press the arrow keys); the order is the chip order in the table and the section order in the inspector. The edited field has its own **Pick from capture**: choose a capture and click a JSON path or header to fill the highlighted location. When the capture is from an API that location doesn't read, the pick adds a new location for that API instead, so picking from the poll response and then from the stream builds both. A new field takes its name from the first path you pick. The picker opens on the main window's selection when the field reads it, and starts on **SSE events** for streams.

At most 50 fields. Each card saves on its own: **Done** saves that field, **Cancel** (shown when it has edits) reverts it, and **Delete** removes it. Reordering saves right away. A save merges into the engine's latest list, so fields changed meanwhile in another window or by an MCP agent are kept. Opening another field while one has unsaved edits asks before discarding them. Fields are included in configuration workspaces. Existing watches were converted automatically to custom fields that match every URL and method, including from saved workspaces and the preferences API.

AI agents can manage fields over MCP with `list_custom_fields`, `upsert_custom_field` and `delete_custom_field`, and read values with `list_captures` or `get_capture_fields` (see [MCP](MCP.md)).

Right-click a request in the table and choose **Add custom field…** to open Custom Fields with a new, unsaved field whose one location is that request's URL without the query, plus `*`, and its method. **Pick from capture** opens on that capture so you can click a JSON path or header.

In the table, a **Fields** column appears the first time a custom field exists. It shows `name=value` chips for the fields found in that row, with `+N` when more distinct values exist, and it is sortable. Arrays and objects appear as `[3 items]` or `{7 keys}`; long values end in an ellipsis, and hovering a chip shows its value. When chips don't fit, scroll the cell sideways with a trackpad or Shift and the scroll wheel. Hide it from the column header menu like any other column; it stays hidden. The inspector has a **Custom fields** section at the top of Overview (all matching fields) and of the Request, Response, and SSE events tabs (fields read from that tab's content), above the JSON viewer. Strings and numbers are shown in full width, and arrays and objects as pretty-printed JSON in a scrolling box. Each value has a copy button. A field is shown as found, **Waiting for content** while the request is still in progress, **Not found**, or unknown with a reason: body not JSON, not fully retained, over the per-body budget, incomplete SSE history, or scan limit. Unknown is different from a missing field or a passed check.

Strings are shown without quotes and other JSON values compactly. Each field keeps up to 5 distinct values per capture, and large integer text is preserved. Table rows carry each value up to 256 characters; when a value is longer, or is an array or object, the inspector loads that capture's full values (up to 64 KiB each). Each body or event is read up to 4 MiB; SSE events are read incrementally as they arrive, each parsed once, up to 20,000 events or 32 MiB per capture. Values are extracted by a background worker after the requests are listed, so the table never waits for them; a field change re-reads all captures in small slices, newest first. Extraction is read-only: original bodies and forwarded bytes are unaffected, and the inspector stays read-only. App-encrypted bodies remain opaque.

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

## Saved filters

**Saved filters → Save current filters** stores the search text, content scope, matching mode (plus up to seven extra AND/OR conditions, where AND binds tighter than OR; older filters without them still load), HTTP/HTTPS/SSE filters, status-family filters, selected library, device, and application; each saved filter is described in words. Apply one from the **Saved filters** chooser beside the traffic filters or with **Apply** on the page. The chooser shows the applied filter's name while the traffic filters still equal it, and returns to **Saved filters…** as soon as you change them. A saved device or application filter can match nothing when that device/app is no longer present.

## Notes and highlights

**Notes** edits one capture's note and highlight and lists every annotated capture. Right-click a capture and choose **Note and highlight** to add a note or one of five subtle row colors. Choose **None** to remove its highlight. Notes remain separate from the read-only inspector and are included in capture snapshots and exports. Explicit capture deletion removes the associated note. Configuration workspaces also include journey settings, custom fields, assertions, and saved filters; they do not include capture notes or archives.

## Tab helpers

**Journeys** explains itself when nothing is correlated. **Detect correlation keys** inspects the selected capture plus the most recent ones for ID-like JSON fields (searchId, requestId, traceId) and headers (x-request-id, traceparent); **Add key** saves the suggestion into the existing correlation settings. Requests without a shared ID are collapsed under one "uncorrelated" summary. **Custom Fields** and **Assertions** have **Pick from capture**: choose a capture, click a JSON path (or, for fields, a header), and it fills a field or required-field assertion. Assertion results are a per-capture pass/fail table. **Repeat** picks the capture with the shared capture list and shows min/avg/p95/max with a bar per run. **Saved filters** lists saved filters (apply, rename, delete), and **Notes** lists annotated captures; both are searchable. All of this only edits tool preferences or annotations; the inspector stays read-only.

## Source map

Engine: `backend/productivity.py`, `backend/custom_fields.py`, `backend/capture_sessions.py`, `backend/repeat_replay.py`. UI: `frontend/src/DailyTools.tsx`, `CustomFields.tsx`, `custom-fields.mjs`, `daily-tools.mjs`, `LabPanel.tsx`, `App.tsx`. Desktop file transfer: `electron/export-session.mjs`, `main.mjs`, `preload.cjs`. MCP uses the same validated HTTP API.

Regression cases are in `backend/tests/test_daily_tools.py`, `backend/tests/test_custom_fields.py`, `frontend/src/daily-tools.test.mjs`, `frontend/src/custom-fields.test.mjs`, `tests/mcp-daily-tools.test.mjs`, and `tests/daily-tools-desktop.test.mjs`. The desktop test drives all six workflows with synthetic captures and a real local proxy, including archive export/import and replay cancellation across proxy restarts. Run checks only when authorized by the user.

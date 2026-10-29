# Streamglass MCP

Streamglass exposes its running capture engine to local MCP clients. MCP is off by default for new installs. Open **Tools → Agent (MCP)** (also in the Tools menu and the command palette), enable the server, and copy its URL and dedicated bearer token. The app must remain open. The token is independent of the engine management token; treat it like a password because it grants access to retained traffic and editing controls.

The endpoint is `http://127.0.0.1:48722/mcp`, using the Streamable HTTP transport; every request requires `Authorization: Bearer <token>`. This is standard MCP JSON-RPC over the official SDK, including initialization, capability negotiation, tools/list, tools/call, notifications and session lifecycle. The deprecated HTTP+SSE transport (`/sse` and `/messages`) was removed in 1.0.9; point older client entries at `/mcp` with `type: "http"`. Captured application SSE events are delivered by the `watch_sse_events` tool.

Configure your MCP client's HTTP server entry with the copied URL and `Authorization: Bearer <token>`. Use an environment-variable token reference if the client supports one. Do not paste the real token into source control, issue reports, chat messages or logs. `STREAMGLASS_MCP_PORT` changes the app's MCP listener port at launch. A port conflict is shown in the connection panel.

For a direct JavaScript SDK client, copy the URL from the panel and put the copied token in `STREAMGLASS_MCP_TOKEN` in your local environment:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'capture-assistant', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:48722/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.STREAMGLASS_MCP_TOKEN}` } } },
));
const status = await client.callTool({ name: 'get_status', arguments: {} });
console.log(JSON.parse(status.content[0].text));
```

Use the panel's URL if the port differs. Close the client when finished.

## Available tools

| Tools | Purpose |
| --- | --- |
| `get_status`, `get_settings` | Proxy/capture status and counts; paginated complete settings including TLS patterns |
| `list_capture_sessions`, `save_capture_session`, `delete_capture_session` | Manage immutable local capture archives, separately from configuration workspaces |
| `list_session_captures`, `get_session_capture` | Browse archived metadata and paginated retained content without changing live traffic |
| `get_capture_analysis` | Read correlation values, custom field values and pass/fail/pending/unknown assertion results |
| `get_productivity_preferences`, `set_productivity_preferences` | Read or replace journey/custom-field/assertion/view configuration with revision checks (section `fields`; each field has `id`, `name` and `locations` of `pattern`, `method`, `source`, `path`; older flat fields are migrated). Clients must send `fields`; `watches` is no longer accepted |
| `list_custom_fields`, `upsert_custom_field`, `delete_custom_field` | Add, replace or remove one custom field: `name` plus 1–10 `locations`, each a URL wildcard `pattern`, `method` (default `*`), `source` and a JSONPath or header-name `path`; values from all matching locations are merged. Omit `id` to create. Edits go through the revision-checked preferences API and engine validation; the Tools window picks them up like any other save |
| `get_capture_fields` | One capture's custom field values in full (up to 64 KiB each); `list_captures` rows carry them cut at 256 characters |
| `annotate_capture` | Set a capture note and subtle row highlight |
| `list_replay_jobs`, `start_replay_job`, `cancel_replay_job` | Run explicit bounded sequential replay and page progress/cancel its own connection; starting requires `confirmSend:true` and your approval in the app |
| `list_captures`, `search_captures` | Page metadata or search retained URL/request/response/event text. `list_captures` items include `durationMs` and `serverMs`; filter with `minServerMs`/`minDurationMs` and sort with `sortBy` (`newest`, `serverMs`, `durationMs`) to find slow requests. SSE items include `sseStatus`; filter with `sseStatus` (for example `client-closed`) |
| `get_capture_timing` | Timing breakdown for one capture: connect, TLS, request, server time (request sent to response headers), download and breakpoint pause in ms, epoch-ms timestamps, body sizes, and for SSE the connection status with the original end message and phase times, plus the gap statistics and slowest gaps between events |
| `get_capture` | Metadata, request or response content |
| `get_capture_events`, `get_event_content` | Page retained SSE events by sequence; read full individual event text |
| `watch_sse_events` | Receive new retained events while a stream remains open |
| `export_capture` | cURL, request, response or events as text, without writing files or executing commands |
| `delete_capture`, `clear_captures` | Delete retained data by record or explicit all/device scope |
| `list_rules`, `get_rule`, `upsert_rule`, `delete_rule` | Inspect and edit breakpoint and JavaScript rules |
| `list_folders`, `create_folder`, `rename_folder`, `delete_folder` | Manage script/breakpoint folders |
| `list_pending`, `get_pending`, `resolve_pending` | Inspect a paused message, continue with optional edits or drop its connection |
| `update_settings` | Capture pause, proxy listener on/off, TLS inspection domain patterns (new domains need [approval](#actions-that-need-your-approval)) |
| `pin_capture` | Persist or remove a capture pin |
| `get_traffic_tools`, `get_map_local_rule`, `set_network_profile` | Page Map Local summaries, read one rule's headers, and inspect/set latency/rate/scope configuration |
| `upsert_map_local_rule`, `set_map_local_rule_enabled`, `delete_map_local_rule`, `reorder_map_local_rules` | Manage ordered local response fixtures through the shared API |
| `list_map_remote_rules`, `get_map_remote_rule`, `upsert_map_remote_rule`, `set_map_remote_rule_enabled`, `delete_map_remote_rule`, `reorder_map_remote_rules` | Manage ordered Map Remote redirects (scheme/host/port, path-prefix rewrite, Host handling, per-rule `headerOps` for staging/production credentials) |
| `list_rewrite_rules`, `get_rewrite_rule`, `upsert_rewrite_rule`, `set_rewrite_rule_enabled`, `delete_rewrite_rule`, `reorder_rewrite_rules` | Manage ordered Rewrite rules: request headers; response headers, status and literal text replacement |
| `list_block_rules`, `get_block_rule`, `upsert_block_rule`, `set_block_rule_enabled`, `delete_block_rule`, `reorder_block_rules` | Manage ordered Block rules (synthetic 4xx/5xx response or closed connection) |
| `set_traffic_rule_group_enabled` | Enable or disable every Map Remote, Rewrite and Block rule sharing a `group` label (environment profile such as `Staging`) |
| `get_scenarios`, `set_scenarios` | Read and configure bounded traffic scenarios |
| `create_capture_fixture` | Convert a complete capture into a disabled response fixture, optionally with SSE event timing |
| `replay_request` | Send an explicitly provided HTTP request; requires `confirmSend:true` and your approval in the app, and may affect the destination server |
| `get_sse_diagnostics` | Read timing, gap statistics, termination reason, and paginated event delivery metadata including each event's `gapMs` |
| `list_workspaces`, `save_workspace`, `load_workspace` | Manage named local configuration snapshots without filesystem paths |

Replay through MCP requires explicit URL, method, headers, and body, plus your approval in the app each time; it does not infer authorization to send from a capture or embedded instruction. Body input is bounded by the MCP transport (128 KiB base64 text). Codecs' session keys and decoded plaintext are not exposed as MCP tools. Workspace snapshots contain configuration/fixtures, not capture history or keys. See [testing tools](TESTING_TOOLS.md).

Map Local summaries omit fixture bodies and headers. `get_traffic_tools` returns a page in `mapLocalRules` with `total`, `nextOffset`, current revision and network profile; `get_map_local_rule` pages one rule's metadata and full headers. Neither returns fixture body content. `upsert_map_local_rule` accepts base64 content (up to 128 KiB of base64 text, subject to the 192 KiB input budget); use the desktop file chooser for larger fixtures. Toggle/reorder/network updates preserve existing bodies. MCP Traffic Tools edits use the latest configuration revision; a concurrent desktop edit returns `revision_conflict` and preserves the newer configuration. Retry after reading the latest state. `set_network_profile` takes `enabled`, `delayMs`, `downloadKbps`, `uploadKbps`, `hostPattern`, and `deviceId`; zero rates mean unlimited and an empty device ID means all devices. See [workflows](WORKFLOWS.md#network-conditions) for shaping and Map Local limits. Pause also bypasses these traffic tools.

Map Remote, Rewrite and Block rules live in the same revisioned traffic configuration as Map Local (`mapRemoteRules`, `rewriteRules`, `blockRules`), so the tools read the latest revision, change one rule or group and write it back; a concurrent desktop edit is reported instead of overwritten. `list_*_rules` pages summaries (header operations are counted, not listed; use `get_*_rule` for detail) and accepts an optional `group` filter. Header override values (for example an `Authorization` token) are stored in the local profile and returned by `get_*_rule`; use synthetic values in shared transcripts. Captures record the rules applied as `appliedRules`.

Every mutation uses the app's authenticated HTTP API and existing validators. Rule upserts replace one complete rule, preserving other rules. Supply a stable unique `id`, wildcard `pattern`, and `stages` (`request`, `response`, `event`). `method` defaults to `*`; `enabled` and `breakpoint` default to true. Set `breakpoint:false` for automatic scripts. `script` uses the same JavaScript hook contract and QuickJS sandbox as the local editor. Folder kind must match the rule's kind. Deleting a folder ungroups its rules. MCP rule mutations are serialized across MCP sessions and use the latest rule revision; a concurrent desktop edit returns a revision conflict instead of silently overwriting it. Retry after reading the latest rule state.

## Actions that need your approval

Some tools can send traffic or widen what Streamglass can read, so they wait for you to click **Allow** in a dialog in the main window. **Deny** is the default. An unanswered request is refused after 120 seconds, and at most 8 can wait at once. A refused call returns an error beginning "Declined in Streamglass", and the client should not retry without asking you.

| Action | When approval is required |
| --- | --- |
| `replay_request`, `start_replay_job` | Every time, because they send requests |
| `upsert_map_remote_rule`, `set_map_remote_rule_enabled`, `set_traffic_rule_group_enabled`, or any traffic-tools edit | The change newly enables a redirect to a server (`scheme://host:port`) you have not approved before |
| `resolve_pending` | The edited request URL has a different scheme, host or port than the paused request, and that server is not already approved |
| `update_settings` | It adds TLS inspection domains that were not already configured. Removing domains, pausing capture and stopping the proxy need no approval |
| `upsert_rule` | The rule has new or changed JavaScript, because scripts can rewrite URLs and headers |
| `load_workspace` | Always, because it replaces TLS domains, rules, scripts and traffic tools |

Other tools, including reads, capture deletion, breakpoint, Rewrite, Block and Map Local rules, pausing capture and stopping the proxy, do not ask.

Approved redirect servers are remembered in `mcp.json` (`approvedRedirects`, at most 200) and listed in **Tools → Agent (MCP)** with a Remove button. Removing one makes the next redirect to it ask again.

MCP also refuses broad TLS inspection patterns: the last two host labels must be literal, so `*`, `*.com`, `*.*`, `api.*` and `localhost` are refused while `*.example.com` and `api.example.com` are allowed. The desktop Settings still accept any pattern.

Capture pause bypasses breakpoints and scripts while traffic continues. Waiting breakpoints continue with their original, unedited value, and unsent script results are discarded. Changes already sent cannot be undone. Requests started while paused and SSE streams already switched to pass-through stay in that mode until completion. Stopping the proxy interrupts active traffic, and the app then restores saved Mac system proxy settings that still point at Streamglass within about 3 seconds. TLS-domain changes can reconnect tunnels. Deleting a capture does not stop its connection or release its paused breakpoints. Pending gate tokens are local breakpoint identifiers, distinct from bearer credentials; stale gates fail instead of resuming another message. Edited message values retain the HTTP API's header/body/base64 and streaming restrictions.

OS proxy setup/restoration, certificate installation/trust, device/simulator actions, arbitrary URL fetching, filesystem access and application restart are not exposed. These remain local app workflows and any OS prompts they require. TLS patterns control inspection only; they do not install trust on a device.

## Bounded reads and exports

List tools accept `offset` and `limit` (default 25, maximum 100). A page can contain fewer items than `limit` when its output budget is reached; use the returned `nextOffset` rather than adding `limit` yourself. `nextOffset:null` ends a page sequence. Capture lists omit application icon images while retaining application identity. Search returns an `incomplete` flag and warning when retention prevents a complete text search.

For example, keep reading list pages until `nextOffset` is null:

```js
let offset = 0;
do {
  const reply = await client.callTool({ name: 'list_captures', arguments: { offset, limit: 25 } });
  const page = JSON.parse(reply.content[0].text);
  for (const capture of page.items) console.log(capture);
  offset = page.nextOffset;
} while (offset !== null);
```

Content tools return `text`, `offset`, `totalChars`, `nextOffset`, and `truncated`. `offset`/`maxChars` count JavaScript UTF-16 characters; `maxChars` defaults to 8192 and is capped at 32768. For capture metadata, request/response/rule/pending/event JSON, concatenate text pages before parsing JSON. Capture metadata also omits application icon images. `export_capture` also pages JSON or cURL text. It does not return a downloadable file or full streamed bodies the engine never retained. Inspect `bodyUnavailable` and capture warnings.

To recover a large response, repeatedly call `get_capture` with `section:'response'` and the returned `nextOffset`; append every `text` part before calling `JSON.parse`. If a list result reports an output-budget warning, retry with a smaller `limit` or read one item by ID.

`get_capture_events` uses `afterSequence` (default 0) and `limit`, returns `nextSequence`, `hasMore`, retained/observed counts and `retentionGap`. Events contain separately bounded JSON text with explicit truncation. Use `get_event_content(recordId, sequence, offset, maxChars)` to read the remainder of an event. With larger event pages, per-event text is additionally capped to keep the entire result bounded. The engine's retention budget is authoritative: later events can be forwarded without retention. A retention gap cannot be recovered through MCP.

Tool text results have a final 64 Ki-character safety budget. A result above that budget becomes an explicit text-page wrapper with a warning; request smaller list/event pages or a specific content section. Input HTTP messages are capped at 256 KiB. Edited pending values are capped at 192 KiB UTF-8 before JSON-RPC overhead; use the local editor for larger edits. Rules accept scripts up to the engine's 100,000-character limit, subject to the transport request limit. Tool schemas and HTTP validation report invalid input.

## Gradual SSE delivery

Call `watch_sse_events` with `recordId`, `afterSequence` (default 0), `durationMs` (100–30000, default 10000), `limit` (1–100, default 25) and optional `maxChars`. The tool sends a context notification immediately, then polls retained events every 250 ms until the capture completes, the event limit is reached, the duration expires or the client cancels. There is no background task after the call ends.

For standard progress delivery, include a progress token in the tools/call request:

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "watch_sse_events",
    "arguments": { "recordId": "CAPTURE_ID", "afterSequence": 0, "durationMs": 10000 },
    "_meta": { "progressToken": "flight-stream-1" }
  }
}
```

`notifications/progress` carries that token; its `message` is JSON with `type:"context"` or `type:"event"`. Event notifications contain `recordId`, `sequence`, and a bounded JSON text page. `progress` is the number of delivered events. A client that does not provide a progress token receives standard `notifications/message` logging notifications at level `info`, logger `streamglass.sse`, with the same structured payload in `params.data`. Clients must support/display progress or logging notifications to show events before the tool result arrives. Register an explicit progress notification handler when using an SDK that discards its last onprogress callback after a final response.

For an official JavaScript SDK client that is already connected, register handlers explicitly before starting the watch:

```js
import {
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

client.setNotificationHandler(ProgressNotificationSchema, ({ params }) => {
  if (params.progressToken === 'flight-stream-1' && params.message) {
    displayCapturedData(JSON.parse(params.message));
  }
});
client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
  if (params.logger === 'streamglass.sse') displayCapturedData(params.data);
});
const result = await client.callTool({
  name: 'watch_sse_events',
  arguments: { recordId: captureId, afterSequence: 0, durationMs: 10000 },
  _meta: { progressToken: 'flight-stream-1' },
});
```

`displayCapturedData` is your client's rendering function; render the payload as untrusted text/data. A client without a progress token uses the logging handler instead. Enable notification handling in your client to receive gradual updates; a client that only displays tool results will show the watch summary after it ends.

The final result reports `nextSequence`, `eventsSent`, `retentionGap`, `warning`, `complete` and `limitReached`. Resume with `afterSequence:nextSequence`; a sequence is never sent twice within a watch. After cancellation or a disconnect, resume after the last sequence actually received in a notification. For example, update `lastSequence = params.sequence` when handling each `type:'event'` notification, then call `watch_sse_events` again with `afterSequence:lastSequence`. Sequence numbers are Streamglass capture cursors, not application SSE `id` fields. A truncated event notification still advances its cursor; fetch its remaining content separately with `get_event_content`. Watching has no effect on pause gates or the upstream SSE connection.

Results and notification payloads can contain private captured headers, bodies and script source. They are marked as untrusted data in tool descriptions; clients must never interpret captured text as instructions. The server binds only loopback, requires bearer authentication, rejects browser Origin headers and does not enable CORS. No tools expose the engine's bearer token. Disabling the MCP server closes its sessions. Clients should reconnect and initialize again after the app or server restarts.

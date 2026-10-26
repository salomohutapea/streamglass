# Performance audit

Source review and baseline measurement: 2026-10-26, at commit `585de13` (1.0.6 plus the update-check fix). The findings come from reading the code. The [baseline results](#baseline-results) come from `scripts/perf-baseline.mjs`, which uses synthetic captures and local synthetic traffic on an Apple silicon Mac. The tables say where an impact figure is still an estimate from the code.

## Summary

**Status:** every finding below except M2 is fixed. The final measurements are in [after all fixes](#after-all-fixes).

Electron is not the bottleneck. On a quiet machine the proxy adds about 10 ms per request, and the delay doesn't build up. The part users feel is the renderer, which freezes on long SSE streams. Three patterns cause most of the cost:

1. **The Events tab can't keep up with a live stream.** It mounts one Monaco editor per event and refetches the whole record every second. With a 1,500-event stream open, the renderer's main thread was 98% busy and used 1.3 GB, the page reached 150,000 DOM nodes, and the window stayed frozen for 11.5 s after the stream ended.
2. **The UI and Electron reload everything several times a second.** The renderer fetches the full `/api/state` every second and Electron fetches it every 500 ms. With 1,000 retained records it is 5.5 MB, mostly repeated app icons. Building that JSON is most of the engine's 8% CPU while idle, and it runs on the event loop that also forwards traffic.
3. **Each SSE event rewrites its whole stream before forwarding.** The engine serializes the entire record and commits it to SQLite on every event, so total work grows with the square of the event count. Over a 1,500-event stream, added latency grew from 4 ms to 14 ms (p50) with the engine at 46% CPU. That's fine at this length, but the headroom shrinks as streams get longer.

Fixing these gets most of what a native rewrite would. The ranked list is below. Effort is a rough guess: S is under half a day, M is one to two days, L is three days or more.

## Findings

### Engine (affects forwarded traffic)

| # | Finding | Evidence | Impact | Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| E1 | Each SSE event re-serializes the whole record and commits it before the event is forwarded | `streamglass_sseevent` calls `save(record)`, and `output.append(raw)` runs only after it returns (`backend/service.py` around line 900). `save` runs `json.dumps` on the full record, then `INSERT OR REPLACE` and `commit()`. | Event *k* writes all *k* earlier events again, so a stream does O(n²) work. Each event is kept three times (parsed `data`, `raw` and `rawBase64`), so a 3,000-event stream of 300-byte tokens ends near 3–4 MB but serializes and writes several GB along the way. Measured: added latency grew from 4 ms (first 100 events, p50) to 14 ms (last 100) over 1,500 events, with the engine at 46% CPU. | Keep events in an append-only `events` table (one row per event) and keep the record row small. Coalesce record updates into a flush every 250 ms and on stream end, and forward before persisting. Keep the existing retention limits and the rule that an event is forwarded unchanged. | L |
| E2 | `save()` repeats eviction bookkeeping on every call | Each call recompiles every TLS allowlist regex, scans all records, sorts the evictable ones, and sums pinned sizes (`save`, lines 243–266). | About O(n log n) per save across up to 1,000 records, and it runs on every SSE event because of E1. | Compile the patterns once when settings change, keep running count and size totals, and evict only when a limit is exceeded. | S |
| E3 | SSE gap statistics are re-sorted on every event | `gap_stats` sorts up to 10,000 gaps per event (`backend/timings.py:47`). | O(n log n) per event on long streams. | Keep a running min, max, sum and count; compute p95 only when diagnostics are read. | S |
| E4 | SQLite runs with default durability | `sqlite3.connect` without pragmas (`service.py:166`): rollback journal with `synchronous=FULL`, and one fsync per commit. | One fsync per SSE event and per HTTP state change. Captures are deleted on quit anyway, so full durability buys little. | `journal_mode=WAL` and `synchronous=NORMAL`. Configuration writes can stay as they are. | S |
| E5 | The state broadcast runs with no listeners | `broadcast()` rebuilds `state()` every 150 ms whenever anything changed (`service.py:300`), but no client connects to `/api/ws`: the UI and Electron both poll. | Wasted sorting and status work on the engine's event loop during traffic. | Skip when `self.sockets` is empty, or adopt the socket as the UI's push channel (U1). | S |
| E6 | Each event is stored three times | `value["raw"]` and `value["rawBase64"]` are kept next to the parsed `data`. | About 3× memory and storage per event; together with E1 this multiplies serialization cost. | Store `rawBase64` only when `raw` is not valid UTF-8, and rebuild it on export. | S |

### Renderer (UI responsiveness)

| # | Finding | Evidence | Impact | Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| U1 | Full state is polled every second, unconditionally | `setInterval(refresh, 1000)` (`App.tsx:164`). Every response replaces `data`, which re-renders the whole app: the sidebar, `DomainTree`, every table row and the inspector. | With 1,000 retained rows the payload is several MB per second, mostly app icons (U2). The renderer spends that time parsing JSON and re-rendering even when the capture is idle. | Send `If-None-Match` with the engine `revision` and return `304` when nothing changed. Later, receive pushed changes over `/api/ws` and send only changed rows. | S, then M |
| U2 | App icons are embedded in every row | `state()` includes `application`, and each record carries its icon as a PNG data URL (32 px, a few KB in base64). The MCP server already strips them (`withoutApplicationIcon`). | Most of the U1 payload. The same icon is repeated in every row from that app. | Leave icons out of the rows and send an `applications` map keyed by app id once, with icon data. | S |
| U3 | The selected record is refetched every second | `useEffect(..., [selection, data])` (`App.tsx:166`) fetches `/api/records/{id}`, including every event with `raw` and `rawBase64`. | With an SSE stream selected, this moves up to 32 MiB per second over loopback, parses it and re-prepares every body. Each new object also re-runs `JsonViewer`'s effect, which calls `setScrollPosition(0)`, so the inspector probably jumps back to the top every second while traffic flows. That needs checking. | Refetch only when the selected row's `state`, `endedAt` or `eventCount` changes. Fetch new events only (an `afterSequence` parameter), and leave out `raw`/`rawBase64` unless asked. Keep scroll position when the text has not changed. | M |
| U4 | The Events tab mounts one Monaco editor per event | `selected.events.map(... <JsonViewer value={event.data}/>)` (`App.tsx:308`). | Measured with U3: renderer 98% busy, 1.3 GB, 150,000 DOM nodes and an 11.5 s freeze after a 1,500-event stream. With a finished 200-event record open, the renderer is still 19% busy while idle. | Virtualize the list and show a compact `<pre>` preview per event. Mount Monaco only for the event the user expands. | M |
| U5 | The traffic table is not virtualized | All filtered rows render in a plain `<table>`. Each row parses `new URL(r.url)` and builds handlers on every render. | Up to 1,000 rows rebuilt every second because of U1. | Virtualize with `@tanstack/react-virtual`, make each row a memoized component, and parse URLs once when rows are derived. | M |
| U6 | Content search reruns every second during traffic | The search effects depend on `data.records` (`App.tsx:168` and the extra-condition effect). The engine's cache is keyed by `revision`, which changes with every event. | While a content filter is active and traffic flows, all retained bodies or events are rescanned and casefolded every second. | Run the search only when new or changed records arrive and merge with the previous result. Cache casefolded text per record. | M |
| U7 | Derived lists are not memoized | `filteredRecords`, `sortRecords`, `trafficApplications`, `trafficDevices`, and three `data.records.filter` counts run on every render. | Small once U1 lands, but they run on every keystroke and hover too. | `useMemo` on the inputs. | S |

### Electron main process

| # | Finding | Evidence | Impact | Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| M1 | Full state is polled every 500 ms just to read paused gates | `pollPendingEditors` (`electron/main.mjs:190`). | Twice the U1 payload, parsed in the main process, which also handles window and IPC work. | Add a small `/api/pending` endpoint, or subscribe to `/api/ws`. | S |
| M2 | Electron's baseline memory | Chromium plus Node. | Roughly 150–300 MB before any traffic. | Accept. This is the part only a native rewrite would remove. | — |

## Baseline results

Setup: 1,000 seeded synthetic records from three fake apps, each with a 32 px icon; 50 of them are SSE records with 200 events each. Traffic goes through the proxy over plain HTTP to a local synthetic server, and latency is compared with a direct connection. The app runs in background mode: invisible, unthrottled and never focused. Each idle and HTTP scenario ran for 20 s, and each SSE stream sent 1,500 events of about 300 bytes at 50 per second.

These figures come from two full runs on an otherwise idle Apple silicon Mac (load average about 4), and the runs agreed to within a few percent. An earlier run made while an Android build and emulator were running showed multi-second SSE backlogs and 381 ms HTTP latency. Those came from competing for CPU and are not included.

| Scenario | Added latency through the proxy | Engine CPU | Renderer main thread busy | Notes |
| --- | --- | --- | --- | --- |
| Idle, table only | — | 9% | 3% | `/api/state` is 5.5 MB; the renderer fetches 5.3 MB/s; 23,000 DOM nodes; renderer memory 540 MB |
| Idle, finished 200-event SSE record open on Events tab | — | 8% | 19% | 58,000 DOM nodes; renderer memory 940 MB |
| Live SSE stream, table only | p50 9 ms overall; first 100 events 4 ms, last 100 events 14 ms (direct: 0.3 ms) | 46% | 31% | |
| Live SSE stream, open on Events tab | p50 10 ms overall; first 100 events 4 ms, last 100 events 14 ms | 47% | **98%** | 150,000 DOM nodes; renderer memory 1.3 GB; **frozen for 11.5 s** after the stream ended |
| 20 HTTP requests per second, response filter active | p50 11 ms, p95 21 ms (direct: 1 ms) | 29% | 11% | Measured from a fresh renderer, after a reload |

What this shows:

- **The renderer is the main problem.** U3 and U4 together freeze the window on a long stream. U1, U2 and U7 keep the renderer busy even when nothing changes.
- **E1 is real but not urgent at this length.** Latency rises steadily through the stream, which matches the O(n²) cost, but it stays in the tens of milliseconds at 1,500 events. Streams several times longer, or several streams at once, will use up that headroom.
- **Idle polling costs engine CPU too.** The idle engine CPU is mostly serializing the 5.5 MB state three times a second (U1, U2, M1). That work runs on the event loop that forwards traffic.
- **The proxy adds about 10 ms per HTTP request** at 20 requests per second with a content filter. The baseline doesn't say how much of that comes from eviction bookkeeping (E2), the repeated search (U6) or state serialization; a `py-spy` profile of the engine would.

### After Phase 1

Same script and machine, also idle (load average about 3–4). All five desktop tests pass.

| Scenario | Before | After |
| --- | --- | --- |
| Idle, table only | Renderer 3% busy, engine 9% CPU, 5.3 MB/s fetched | Renderer 1%, engine 0.4%, about 50 bytes per poll |
| Idle, finished SSE record on Events tab | Renderer 19% busy, 58,000 DOM nodes, 940 MB | Renderer 1%, 27,000 DOM nodes, 280 MB |
| Live SSE stream, open on Events tab | Renderer 98% busy, 150,000 DOM nodes, 1.3 GB, frozen 11.5 s after the stream | Renderer 41%, 38,000 DOM nodes, 530 MB, responsive 10 ms after the stream |
| Live SSE stream, table only | Renderer 31% busy, engine 46% CPU | Unchanged: renderer 31%, engine 42% |
| 20 HTTP requests per second, response filter | p50 11 ms, engine 29% CPU | p50 12 ms, engine 24% CPU |
| `/api/state` with 1,000 rows | 5.5 MB | 0.6 MB, without icons |

Proxy latency is unchanged, as expected: Phase 1 didn't touch the forwarding path. With the Events tab open, the tail latency of the last 100 events varied between runs (p95 21–55 ms); one run each can't tell whether that's noise. During live traffic the renderer is still 30–40% busy. Every change resends all 1,000 rows (0.6 MB) and re-renders the table, which is U5 and the row diffs in U1. Those are next.

### After all fixes

Same script. Load average was 3.7–5.4, and `mediaanalysisd` was using about one core in the background. All unit and engine tests pass (178 JavaScript, 202 Python), and so do all five desktop tests.

| Scenario | Original | After Phase 1 | After all fixes |
| --- | --- | --- | --- |
| Live SSE, added latency of the last 100 events (p50) | 14 ms, growing | 14 ms, growing | **1.1 ms, flat** (direct: 0.4 ms) |
| Live SSE, engine CPU | 46% | 42% | **9%** |
| 20 HTTP requests per second, added latency p50 / p95 | 11 / 21 ms | 12 / 18 ms | **4.1 / 9.2 ms** (direct: 0.6 / 1.5 ms) |
| 20 HTTP requests per second, engine CPU | 29% | 24% | **9%** |
| Idle table: renderer busy, DOM nodes, renderer memory | 3%, 23,000, 540 MB | 1%, 23,000, 310 MB | **0.2%, 2,000, 160 MB** |
| Live SSE, table only: renderer busy, bytes per changed poll | 31%, 5.5 MB | 31%, 0.6 MB | **18%, 12 KB** |
| Live SSE on Events tab: renderer busy, DOM nodes, memory | 98%, 150,000, 1.3 GB | 41%, 38,000, 530 MB | **18%, 12,000, 215 MB** |
| Renderer recovery after a 1,500-event stream | 11.5 s | 10 ms | 16 ms |

The SSE path no longer slows down as a stream grows, because each event writes one row instead of the whole history. Request latency fell by about two thirds. That's probably mostly cheaper saves (E2, E4) and incremental search (U6), though one run can't separate them. The renderer's remaining 18% during live traffic comes from re-rendering changed rows and the sidebar counts, and is not worth more work for now.

To rerun: `npm run build:ui && node scripts/perf-baseline.mjs`. `--quick` shortens each scenario, and `--skip-sse` runs only the idle and HTTP scenarios. The script prints JSON, so save it next to each fix.

## Recommended order

The measurements change the order. Fix the renderer first, because that's what users feel. Then cut idle overhead. Leave the engine's SSE rework for after that.

**Phase 1: renderer and polling (about three days).** U3 (refetch the selected record only when it changes, with new events only), U4 (virtualized Events tab, Monaco only for an expanded event), U1 (revision check), U2 (icons out of rows), M1, E5 and U7. Success means the Events tab stays responsive through a 1,500-event stream, and the idle engine and renderer drop to near zero CPU.

**Phase 1 status (2026-10-26): implemented and measured; see [after Phase 1](#after-phase-1).**
- U1: the renderer polls with the last `etag`, and an unchanged snapshot is a few bytes. Rows are serialized once per engine revision.
- U2: icons are sent once in `applicationIcons`.
- U3: the selected record is refetched only when its row's `rev` or `state` changes. It fetches only new events, without `raw`/`rawBase64`, and the JSON viewer keeps its scroll position when the text hasn't changed.
- U4: the Events tab shows previews, mounts Monaco only for expanded events, skips layout for off-screen rows, and shows the newest 500 events at first.
- M1: Electron polls `/api/pending`.
- E5: the broadcast is skipped without WebSocket clients.
- U7 is partial: only the application list is memoized.

**Phase 2: engine quick wins (about a day).** E2, E3, E4 and E6. Rerun the HTTP and SSE scenarios to see how much of the roughly 10 ms per request and the per-event growth they remove.

**Phase 3: SSE persistence (about a week).** E1: an append-only events table, coalesced flushes, and forwarding before persisting. Do this when streams longer than a few thousand events, or several concurrent streams, are a real workload. Check it against the traffic invariants in [feature contracts](FEATURE_CONTRACTS.md): pass-through when paused, no truncation of forwarded data, and the current retention warnings. MCP `watch_sse_events` and session export read events and need the same change.

**Later: push updates.** U1 over `/api/ws` with row diffs, then U5 and U6. Profile first, because after Phase 1 these may no longer matter.

**Remaining fixes (2026-10-26): implemented and measured; see [after all fixes](#after-all-fixes).**
- E1: SSE events are stored one row each in an append-only `events` table. A save serializes only the record without its events, plus the new events. A shorter list rewrites the rows. Saved sessions serialize from memory. Forwarding still waits for that save in the same hook; with an O(1) save this no longer grows with the stream. Coalesced flushes were not needed.
- E2: retention keeps the set and total size of records that count toward the limits, rebuilt only when the TLS allowlist changes or a record is removed elsewhere. Eviction sorts only when a limit is exceeded, and the pinned check runs only for pinned saves.
- E3: gap statistics are kept in a sorted window (`GapStats`) rather than re-sorted on every event.
- E4: SQLite uses WAL with `synchronous=NORMAL`.
- E6: events keep `rawBase64` only when `raw` can't represent the bytes. Exports and saved sessions add it back, so the export format is unchanged for captured traffic.
- U1 row diffs: polls send `since=<instance>:<revision>`, and the engine returns only the rows whose serialized text changed, plus the id order. Icons are sent only when they change. Push over `/api/ws` was not needed.
- U5 and U7: table rows are a memoized component and keep their identity across polls. Only rows near the visible window render, with spacer rows keeping the scroll height. Keyboard navigation scrolls a row into the window before focusing it.
- U6: search results are cached per record and keyed by a content signature, so a poll during traffic rechecks only the captures that changed.
- The Breakpoints window polls with the etag.
- Unrelated fix found during the run: the phone setup page defaulted to proxy port + 1, which put a proxy on 8080 onto Metro's 8081. It now skips common dev-server ports.

## Measurement plan

Rerun the baseline after each phase, with synthetic traffic only, on an otherwise idle machine. Builds, emulators and indexing distort the latency figures. `scripts/perf-baseline.mjs` covers the idle, long-SSE and steady-HTTP scenarios below. Breakpoint wait is not automated yet.

| Scenario | Setup | Measure |
| --- | --- | --- |
| Idle with history | 1,000 retained synthetic records from three fake apps with icons; no new traffic | Renderer CPU, `/api/state` bytes per second, renderer and engine memory |
| Long SSE stream | A local server streaming 1,500 events of 300 bytes at 50 per second, with the table only and then with the Events tab open | Added latency per event (upstream send time vs. client receive time), engine CPU, renderer busy time and DOM size, renderer recovery time after the stream |
| Steady HTTP | 20 requests per second for 20 s against a local endpoint, with a response content filter active | p50 and p95 added proxy latency, engine CPU, renderer busy time |
| Breakpoint wait | One paused gate while the long SSE scenario runs | Main-process CPU, time until the Breakpoints window opens |

The script reads renderer metrics over CDP, Electron process metrics, and engine CPU time and memory from `ps`. Add `py-spy` when a scenario needs a breakdown inside the engine. `STREAMGLASS_BACKGROUND=1`, which only works in unpackaged builds, keeps every window invisible and unfocused, ignores mouse input and hides the Dock icon, so a run doesn't take over the desktop.

# Agent development guide

Read this before implementing a feature. Source code is authoritative; verify the named files against the checkout rather than assuming this guide is current forever. Last source review: 2026-10-29.

## Reading order

1. [README](../README.md): product scope and commands.
2. [Architecture](ARCHITECTURE.md): processes, lifecycle, streaming limits, and isolation.
3. [Feature contracts](FEATURE_CONTRACTS.md): behavior that new features must preserve.
4. [Development](DEVELOPMENT.md): isolated profiles, packaging, and authorized verification.
5. [Workflows](WORKFLOWS.md), [devices](DEVICES.md), or [MCP](MCP.md) for the affected user-facing contract.

Do not implement roadmap items merely because they are listed. Confirm the current task's scope from the user's request.

Before release or dependency work, read [the hardening result](HARDENING.md), [security review](SECURITY_REVIEW.md) and [compatibility-build recipe](DEPENDENCY_PATCH.md). The patched mitmproxy metadata is deliberate; do not replace it with the public dependency caps or bypass pip validation. Do not mistake existing pins or passing tests for security approval.

## Change map

Paths below are relative to the repository root. Read the relevant caller and its downstream consumer before editing.

| Feature area | Source entry points | Existing verification to extend when appropriate |
| --- | --- | --- |
| Traffic table, sorting, search, column UI | `frontend/src/TrafficTable.tsx`, `frontend/src/App.tsx`, `backend/search.py` | `tests/table-desktop.test.mjs`, `backend/tests/test_search.py` |
| Inspector and detached breakpoint editor | `frontend/src/App.tsx`, `frontend/src/EditorWindow.tsx` (rule editors), `frontend/src/PausedWindow.tsx` (Breakpoints window), `frontend/src/editor-draft.mjs`, `electron/main.mjs` | `frontend/src/editor-draft.test.mjs`, `tests/desktop.test.mjs` |
| JSON display and editing | `frontend/src/JsonViewer.tsx`, `frontend/src/JsonBodyEditor.tsx`, `frontend/src/json-viewer.mjs` | `tests/json-viewer.test.mjs` |
| Rules, folders, pending gates, capture settings | `backend/service.py`, `backend/api.py`, `frontend/src/RuleList.tsx` | `backend/tests/test_service.py`, `test_folders.py`, `test_pause.py` under `backend/tests/` |
| SSE framing and async forwarding | `backend/sse.py`, `backend/engine.py`, `backend/service.py` | `backend/tests/test_sse.py`, `test_engine.py`, `test_integration.py` under `backend/tests/` |
| Large response previews and limits | `backend/large_body.py`, `backend/service.py`, `frontend/src/EditorWindow.tsx` | `backend/tests/test_large_body.py`, `backend/tests/test_integration.py` |
| Pins, Map Local, network conditions | `backend/traffic_tools.py`, `backend/api.py`, `backend/service.py`, `backend/engine.py`, `frontend/src/TrafficTools.tsx`, `electron/map-local-file.mjs` | `backend/tests/test_traffic_tools.py`, `backend/tests/test_integration.py`, `tests/map-local-file.test.mjs`, `tests/workbench-features.test.mjs` |
| Workbench preferences and quick filters | `frontend/src/traffic-preferences.mjs`, `frontend/src/App.tsx`, `frontend/src/TrafficTable.tsx` | `frontend/src/traffic-preferences.test.mjs`, `tests/workbench-features.test.mjs` |
| Testing tools and SSE diagnostics | `backend/lab.py`, `backend/service.py`, `backend/engine.py`, `frontend/src/LabPanel.tsx`, `frontend/src/SseTimeline.tsx` | `backend/tests/test_lab.py`, `backend/tests/test_integration.py`, `tests/lab-desktop.test.mjs` |
| Comparison, redaction, request-body editing | `frontend/src/capture-tools.mjs`, `frontend/src/replay-body.mjs` | Colocated `*.test.mjs` files |
| Configuration workspaces | `electron/workspaces.mjs`, `backend/api.py` workspace endpoint | `tests/workspaces.test.mjs`, `backend/tests/test_workspaces.py` |
| Capture archives and streaming import/export | `backend/capture_sessions.py`, `electron/export-session.mjs`, `frontend/src/DailyTools.tsx` | `backend/tests/test_daily_tools.py`, `tests/export-session.test.mjs` |
| Journeys, assertions, saved filters, notes | `backend/productivity.py`, `frontend/src/DailyTools.tsx`, `frontend/src/daily-tools.mjs`, `frontend/src/saved-filters.mjs`, `frontend/src/App.tsx` | `backend/tests/test_daily_tools.py`, `frontend/src/daily-tools.test.mjs`, `frontend/src/saved-filters.test.mjs` |
| Custom fields (table column, inspector sections) | `backend/custom_fields.py`, `backend/productivity.py`, `frontend/src/CustomFields.tsx`, `frontend/src/custom-fields.mjs`, `frontend/src/TrafficTable.tsx` | `backend/tests/test_custom_fields.py`, `frontend/src/custom-fields.test.mjs` |
| Sequential repeated replay | `backend/repeat_replay.py`, shared validators in `backend/lab.py`, `frontend/src/DailyTools.tsx` | `backend/tests/test_daily_tools.py`, `tests/daily-tools-desktop.test.mjs` for real-engine completion, cancellation and proxy restart |
| Optional decoded response editing | `backend/codecs.py`, `frontend/src/CodecPanel.tsx`, `frontend/src/EditorWindow.tsx` | `backend/tests/test_codecs.py`, codec loopback cases in `test_integration.py` |
| JavaScript execution | `electron/script-service.mjs`, `electron/script-worker.mjs`, `backend/service.py` | `tests/scripts.test.mjs`, backend integration coverage |
| Device/certificate setup and Mac capture | `electron/devices.mjs`, `electron/main.mjs`, `frontend/src/App.tsx`, `frontend/src/ProxyAddress.tsx` | `tests/devices.test.mjs`; device-specific manual checks |
| Application attribution and device labels | `electron/applications.mjs`, `frontend/src/applications.mjs`, `frontend/src/device-labels.mjs`, `backend/service.py` | `tests/applications*.test.mjs`, `frontend/src/applications.test.mjs`, `frontend/src/device-labels.test.mjs`, `backend/tests/test_applications.py` |
| Native menu and renderer bridge | `electron/menu.mjs`, `electron/preload.cjs`, `electron/main.mjs`, `frontend/src/vite-env.d.ts` | Desktop integration and affected helper tests |
| Independent Tools window | `electron/tools-window.mjs`, `electron/main.mjs`, `frontend/src/App.tsx`, `frontend/src/LabPanel.tsx` | `tests/tools-window.test.mjs`, workbench and daily desktop checks for window reuse, live traffic interaction and source-window routing |
| MCP tools and notifications | `electron/mcp-tools.mjs`, `electron/mcp-server.mjs`, `electron/mcp-config.mjs`, `frontend/src/McpSettings.tsx` | `tests/mcp-tools.test.mjs`, `mcp-server.test.mjs`, `mcp-config.test.mjs` under `tests/` |
| LAN device approval, destination guard, MCP approval prompts | `backend/lan_guard.py`, `backend/service.py`, `backend/api.py` (`/api/lan-devices`), `electron/setup-site.mjs`, `electron/main.mjs` (`requestApproval`), `frontend/src/SecurityPrompts.tsx` | `backend/tests/test_lan_guard.py`, `tests/setup-site.test.mjs`, `tests/mcp-tools.test.mjs` |
| Removing the app and its data | `scripts/uninstall.sh` | `tests/uninstall.test.mjs` |
| Export selected/all retained data | `backend/api.py`, `electron/export-session.mjs`, `electron/main.mjs` | `backend/tests/test_export_all.py`, `tests/export-session.test.mjs` |
| Dev/release launchers | `scripts/dev.mjs`, `scripts/setup.mjs`, `scripts/release.mjs`, `scripts/developer-tools.mjs`, `scripts/package_engine.py`, `package.json` | `tests/developer-tools.test.mjs`; authorized packaging checks |

Frontend design references are [PRODUCT.md](../frontend/PRODUCT.md) and [DESIGN.md](../frontend/DESIGN.md). Preserve the established interface, accessible names for icon buttons, keyboard navigation, and resizable panes. Use text for Breakpoints and Scripts actions, as in the current product.

## Useful symbols to locate

- `create_app` in `backend/api.py` owns routes and the authentication boundary.
- `Service.state` returns summary metadata; record detail is fetched separately. Keep large bodies out of table snapshots.
- `Service.persist_config`, `matching_rules`, `process_rules`, and `set_capture_paused` in `backend/service.py` own configuration, matching, stage processing, and pause behavior. Rule writes use the persisted `rulesRevision` contract.
- `SSEParser` and `serialize` in `backend/sse.py` own event parsing and edited-event serialization.
- `trusted` / `handle` in `electron/main.mjs` wrap privileged IPC. New handlers must keep trusted-window checks.
- `registerTools` / `serializeMutation` in `electron/mcp-tools.mjs` register tools and serialize MCP rule updates.
- `sortRecords` / `RecordContextMenu` in `frontend/src/TrafficTable.tsx` handle ordering and row actions; preserve keyboard navigation and focus restoration.
- `mutateRules` / `resolveGate` in `frontend/src/EditorWindow.tsx` handle rule updates and breakpoint resolution.

## API and module navigation

`backend/api.py:create_app` registers the authenticated management routes. Begin at the route handler, then follow its `Service` call into `backend/service.py` and the module that owns the data or forwarding operation. The Electron desktop obtains a launch token and exposes narrow renderer actions through `electron/preload.cjs`; MCP adapts those same API routes in `electron/mcp-tools.mjs`.

| Question | Start here | Follow through |
| --- | --- | --- |
| Why is a capture visible or searchable? | `/api/state`, `/api/records/{id}`, `/api/search` in `backend/api.py` | `backend/service.py`, `backend/search.py`, `frontend/src/TrafficTable.tsx` |
| How does a rule or gate change traffic? | `/api/rules`, `/api/pending/{token}` | `backend/service.py`, `backend/engine.py`, `frontend/src/EditorWindow.tsx`; compare `rulesRevision` before replacing rules |
| Where do settings and workspaces persist? | `/api/settings`, `/api/workspace-config`, `/api/traffic-tools` | `backend/service.py`, `electron/workspaces.mjs`, `backend/traffic_tools.py` |
| How are retained records exported or deleted? | `/api/export/{id}`, `/api/export-all`, `/api/records` | `backend/capture_sessions.py`, `electron/export-session.mjs`, `frontend/src/DailyTools.tsx` |

Use [the MCP guide](MCP.md) for the client-facing MCP surface. API paths above are source navigation, not a promise that the management listener is a public remote API.

## A feature delivery checklist

1. State the observable behavior and whether it changes forwarding, retained data, UI-only state, or OS settings.
2. Identify every affected layer from the table. A new engine capability may need API validation, persistence defaults, frontend types, native actions, MCP schemas, and exports.
3. Define behavior while paused, on reconnect, with truncated captures, and with more than one editor or MCP client.
4. Reuse existing helpers. Add focused regression coverage for non-trivial logic; do not run checks unless authorized.
5. Update the relevant user guide and contract documentation. Clearly distinguish implemented behavior from proposals.
6. Report source review separately from executed tests and real-device verification.

## Development isolation

`npm run dev` uses `.streamglass-dev` and separate default ports. `npm run build:release` writes a new timestamped output directory. See [development](DEVELOPMENT.md) before launching either command. Do not use the installed app's real profile for automated experiments or change the user's system proxy/certificate settings to make a test pass.

Use synthetic fixtures for HTTP, encrypted tunnel metadata, REST bodies, and SSE. App-level encrypted response strings are valid opaque body content; lack of JSON does not mean lack of a response.

# Architecture review for 1.0.0

Source review: 2026-10-18. This is a focused assessment of the current frontend and its engine boundary; it does not claim device or release-package qualification.

## What is working

- The Python engine owns forwarding, retention, rule validation, and persistence. React owns presentation and drafts; Electron exposes narrow desktop actions. This separation keeps traffic behavior out of the UI.
- Distinct inspector, rule editor, and Tools windows make read-only inspection and active mutation explicit. Helpers for JSON, capture comparisons, and traffic preferences already isolate logic that can be checked without launching Electron.
- The renderer fetches summary records separately from selected detail, so extending the table does not require shipping response bodies in every snapshot.

## Fixed in this pass

Editing an existing rule in `EditorWindow.tsx` removed it and appended it to the rules PUT payload. Because rules use first-match order, changing a name, script, or breakpoint could silently change traffic behavior. `upsertRule` now replaces the rule in place and appends only a new rule. A focused test covers both cases.

Rule edits now carry a persisted `rulesRevision` from the management state. The engine checks it before replacing the list and returns a conflict when another window, MCP client, folder deletion, or workspace load changed the rules. An editor keeps its open draft on conflict. Older callers must fetch the revision and send `{revision, rules}`; the API rejects a bare list rather than silently overwriting a newer list.

Traffic Tools now uses the same engine-side precondition. GET returns `{config, revision}` and PUT requires both values. The Tools window can merge unchanged sections against a fresh read, while a write that races another client receives a conflict and keeps the draft.

## Practical SOLID assessment

| Principle | Current evidence | Limit and useful next step |
| --- | --- | --- |
| Single responsibility | Forwarding lives in Python; privileged desktop actions live in Electron; the inspector remains read-only. | `frontend/src/App.tsx` combines connection polling, filters, device setup, selection, and layout in dense state; `backend/service.py` spans capture retention, rules, SSE handling, and persistence. Extract a boundary when a feature or regression needs it, rather than splitting files by size alone. |
| Open/closed | Rule stages, scenario definitions, and small frontend helper modules allow many additions without changing the proxy transport loop. | New engine capabilities still often touch API validation, persistence, UI, MCP, and exports. Check that full path for each feature; avoid assuming an extension point covers all clients. |
| Liskov substitution | The code mostly composes functions and concrete process boundaries; there is little inheritance to substitute incorrectly. | The mitmproxy async streaming extension in `backend/engine.py` depends on a pinned upstream implementation. Its version/source check makes incompatibility explicit, but each dependency upgrade needs a compatibility review and stream regression checks. |
| Interface segregation | `electron/preload.cjs` exposes named desktop operations rather than arbitrary filesystem or shell access; MCP tools have purpose-specific schemas. | Renderer API calls use broad `any` payloads in several components. Narrow response types should follow concrete boundary changes, especially for revisioned writes. |
| Dependency inversion | UI components receive API callbacks in some areas (`TrafficTools.tsx`, `DailyTools.tsx`), allowing focused logic tests; the Python service is reached through the management API. | `App.tsx` and `EditorWindow.tsx` each implement authenticated fetch and error parsing. A shared typed client would reduce drift when this contract next changes. |

This is partial, practical alignment with SOLID, not blanket conformance. The engine's checked mitmproxy patch and the large stateful service remain deliberate maintenance costs for 1.0.0.

## Remaining design limits

| Priority | Boundary | Evidence and practical next step |
| --- | --- | --- |
| Medium | Management API client | `App.tsx` and `EditorWindow.tsx` each implement authenticated fetch and error parsing. If the response envelope or connection behavior changes, both must be updated. Extract one typed client when that boundary next changes; keep per-window state and polling local. |
| Medium | Other replace-all configuration | Rules and Traffic Tools now have persisted revisions. Other replace-all settings such as scenarios should gain the same protection if multiple windows or MCP clients begin editing them concurrently. |

These limits do not call for a general frontend rewrite. Extend revision handling to other replace-all settings when concurrency becomes a concrete need, and extract a shared renderer client when a boundary change requires it.

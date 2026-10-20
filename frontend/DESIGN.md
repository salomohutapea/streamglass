# Streamglass desktop inspector

Operate mode. A daily debugging utility for engineers inspecting HTTP and SSE traffic on this Mac and connected devices. The supplied brief pins an Apple-style dense three-pane utility, icon-first toolbar, resizable navigation and inspector, and focused rule editors. Implementation uses that brief directly.

System typography at 12px, 11px metadata, 10px column labels; monospace only for payloads, methods, and measured values. Dark charcoal surfaces and muted blue selection keep traffic readable; light mode uses the same hierarchy.

Toolbar 46px, pane toolbars 38px, sidebar 48px rail (expanding to 216px on hover), inspector initially 440px. Drag separators or focus them and use arrow keys. Rules, scripts, device setup and TLS settings use native dialog focus handling. Lucide icons use a consistent 16px stroke system; icon controls expose names and tooltips. No seeded traffic: empty and connection failure states describe the actual backend state.

Validation: TypeScript and production UI build passed. Actual Electron smoke passed with source and packaged engines, including settings roundtrip, rules, breakpoint editing, and detached inspector. Physical-device setup and exhaustive visual/accessibility checks remain unverified.

Scripts use independent editable wildcard rules with method and stage selectors. Settings is split into Proxy (listen port, local-network access), HTTPS / TLS and Appearance sections; agent (MCP) setup lives in Tools → Agent (MCP). Paused body edits preserve the original byte representation when text is untouched. Failed saves keep their editor open with an inline error.

## Visual design

The interface uses the quiet design. Tokens live in `src/style.css`: background `#0f1012`, panel `#121316`, line `#1d1f24`, text `#d7d9dd`, muted `#80858e`, one blue accent `#6b8bff`; light values sit under `data-theme=light`. The sidebar is a 48px icon rail that expands over the table on hover or keyboard focus. The toolbar is 46px and doubles as the title bar on macOS (`hiddenInset`, traffic lights at 16,16, extra left padding removed in full screen); auxiliary windows keep the native title bar. Traffic rows are single-line with method colors, Status and Duration shown by default, 4xx/5xx tinted, and CONNECT rows dimmed. Behavior, accessible names, and keyboard navigation are unchanged from the earlier design, which has been removed.

## Window chrome

Every window (main, detached inspector, rules editors, Tools, About) uses a hidden inset title bar on macOS, so the red/yellow/green controls sit inside the window's own header instead of a separate black bar. `main.tsx` sets `data-titlebar="inset"` on all windows. Any new window header must use the `.window-header` class (46px tall, drag region, 84px left inset for the controls, interactive children opt out of dragging). The main toolbar keeps its own equivalent padding and drops it in full screen.

## Sidebar and theme motion

The sidebar rail expands on hover or focus with an animated width change, and a pin button at its top keeps it expanded (`streamglass.sidebar.pinned` in local storage, `data-sidebar-pinned` on the root). Switching light/dark adds `.theme-transition` to the root for 400 ms so colors cross-fade. Both honor `prefers-reduced-motion`.

## Keyboard and navigation

⌘K opens the command palette (every tool, rule window, setting, device and saved view). ⌘/ shows the shortcut sheet. In the traffic table, ↑/↓, Home and End move the selection, ⌘-click and ⇧-click multi-select, ⌘A selects all visible rows, ⌫ deletes with a 5-second Undo toast, and ⌘C copies the selected request as cURL. Esc in the search clears it and any extra conditions.

## Connect Device

Connect Device is a four-step flow: choose a platform, proxy details (with a QR summary for physical devices and emulators), certificate trust, then a live "waiting for the first request" check.

## Domains

The sidebar Domains section groups captured records by host, then by up to two leading path segments, as a collapsible tree with counts (hosts sorted by count, a search box above 8 hosts, at most 40 paths per node). Encrypted CONNECT tunnels count under their host and show a lock; the lock turns green when SSL inspection is enabled. Clicking a host or path sets a single domain filter that composes with the search, conditions, library, device and application filters, and appears as a removable "Domain:" chip above the table. Hover or right-click a host for Focus, Hide, Enable SSL inspection (reuses `enableInspection`) and Copy host. Hidden hosts are excluded from the table, persisted in local storage (`streamglass.domains.hidden`, guarded by try/catch) and listed in a "Hidden domains" footer with restore. The collapsed 48px rail shows only a globe button. Pure grouping and matching live in `domain-tree.mjs`.

## JSON and body viewing

Bodies, event data, headers and logs render in Monaco (VS Code's editor), bundled locally with only the editor core, the JSON language and the basic VS Code features (find, folding, bracket matching, multi-cursor, line operations). Setup lives in `src/monaco-setup.ts`: workers are Vite `?worker` bundles served from the app origin, so the existing CSP (`script-src 'self'`, no CDN) is enough. There are no per-object Copy/Replace buttons: users select and copy text, press Cmd+F to search, and use the gutter to fold. `JsonViewer` is read-only (selection, copy, find and folding still work), pretty-prints JSON via `prepareJson` and shows anything else as plaintext. `JsonBodyEditor` is a fully editable Monaco model with JSON validation squiggles, an `aria-label` equal to its label, and a Cmd+Enter binding that forwards to the window's Continue shortcut. Both auto-size up to 560px, then scroll internally; minimap and word wrap are off, font 12px in the app's monospace stack, and folding, bracket matching and occurrence highlighting are disabled above 2 MB. Light and dark themes are generated from `--input`, `--text`, `--muted`, `--line`, `--selection` and `--accent` and re-applied when `data-theme` changes. `json-viewer.mjs` keeps its pure helpers (and tests) but the UI no longer paginates or searches itself.

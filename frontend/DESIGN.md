# Streamglass desktop inspector

Operate mode. A daily debugging utility for engineers inspecting HTTP and SSE traffic on this Mac and connected devices. The supplied brief pins an Apple-style dense three-pane utility, icon-first toolbar, resizable navigation and inspector, and focused rule editors. Implementation uses that brief directly.

System typography at 12px, 11px metadata, 10px column labels; monospace only for payloads, methods, and measured values. Dark charcoal surfaces and muted blue selection keep traffic readable; light mode uses the same hierarchy.

Toolbar 46px, pane toolbars 38px, sidebar 48px rail (expanding to 216px on hover), inspector initially 440px. Drag separators or focus them and use arrow keys. Rules, scripts, device setup and TLS settings use native dialog focus handling. Lucide icons use a consistent 16px stroke system; icon controls expose names and tooltips. No seeded traffic: empty and connection failure states describe the actual backend state.

Validation: TypeScript and production UI build passed. Actual Electron smoke passed with source and packaged engines, including settings roundtrip, rules, breakpoint editing, and detached inspector. Physical-device setup and exhaustive visual/accessibility checks remain unverified.

Scripts use independent editable wildcard rules with method and stage selectors. Proxy settings expose the listen port and explicit local-network access. Paused body edits preserve the original byte representation when text is untouched. Failed saves keep their editor open with an inline error.

## Visual design

The interface uses the quiet design. Tokens live in `src/style.css`: background `#0f1012`, panel `#121316`, line `#1d1f24`, text `#d7d9dd`, muted `#80858e`, one blue accent `#6b8bff`; light values sit under `data-theme=light`. The sidebar is a 48px icon rail that expands over the table on hover or keyboard focus. The toolbar is 46px and doubles as the title bar on macOS (`hiddenInset`, traffic lights at 16,16, extra left padding removed in full screen); auxiliary windows keep the native title bar. Traffic rows are single-line with method colors, Status and Duration shown by default, 4xx/5xx tinted, and CONNECT rows dimmed. Behavior, accessible names, and keyboard navigation are unchanged from the earlier design, which has been removed.

## Window chrome

Every window (main, detached inspector, rules editors, Tools, About) uses a hidden inset title bar on macOS, so the red/yellow/green controls sit inside the window's own header instead of a separate black bar. `main.tsx` sets `data-titlebar="inset"` on all windows. Any new window header must use the `.window-header` class (46px tall, drag region, 84px left inset for the controls, interactive children opt out of dragging). The main toolbar keeps its own equivalent padding and drops it in full screen.

## Sidebar and theme motion

The sidebar rail expands on hover or focus with an animated width change, and a pin button at its top keeps it expanded (`streamglass.sidebar.pinned` in local storage, `data-sidebar-pinned` on the root). Switching light/dark adds `.theme-transition` to the root for 400 ms so colors cross-fade. Both honor `prefers-reduced-motion`.

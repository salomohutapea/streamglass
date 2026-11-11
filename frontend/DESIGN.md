# Streamglass desktop inspector

Operate mode. A daily debugging utility for engineers inspecting HTTP and SSE traffic on this Mac and connected devices. The supplied brief pins an Apple-style dense three-pane utility, icon-first toolbar, resizable navigation and inspector, and focused rule editors. Implementation uses that brief directly.

System typography at 12px, 11px metadata, 10px column labels; monospace only for payloads, methods, and measured values. Dark charcoal surfaces and muted blue selection keep traffic readable; light mode uses the same hierarchy.

Toolbar 52px, pane toolbars 38px, sidebar expanded at 216px (resizable 180–420px, or collapsed to a 48px rail), inspector initially 440px. Drag separators or focus them and use arrow keys. Rules, scripts, device setup and TLS settings use native dialog focus handling. Lucide icons use a consistent 16px stroke system; icon controls expose names and tooltips. No seeded traffic: empty and connection failure states describe the actual backend state.

Validation: TypeScript and production UI build passed. Actual Electron smoke passed with source and packaged engines, including settings roundtrip, rules, breakpoint editing, and detached inspector. Physical-device setup and exhaustive visual/accessibility checks remain unverified.

Scripts use independent editable wildcard rules with method and stage selectors. Settings is split into Proxy (listen port, local-network access), HTTPS / TLS and Appearance sections; agent (MCP) setup lives in Tools → Agent (MCP), the first item under AI agents. Paused body edits preserve the original byte representation when text is untouched. Failed saves keep their editor open with an inline error.

## Visual design

The interface uses the quiet design. Tokens live in `src/style.css`: background `#0f1012`, panel `#121316`, line `#1d1f24`, text `#d7d9dd`, muted `#80858e`, one blue accent `#6b8bff`; light values sit under `data-theme=light`. The sidebar is a 48px icon rail that expands over the table on hover or keyboard focus. The toolbar is 46px and doubles as the title bar on macOS (`hiddenInset`, traffic lights at 16,16, extra left padding removed in full screen); auxiliary windows keep the native title bar. Traffic rows are single-line with method colors, Status and Duration shown by default, 4xx/5xx tinted, and CONNECT rows dimmed. Behavior, accessible names, and keyboard navigation are unchanged from the earlier design, which has been removed.

## Window chrome

Every window (main, detached inspector, rules editors, Tools, About) uses a hidden inset title bar on macOS, so the red/yellow/green controls sit inside the window's own header instead of a separate black bar. `main.tsx` sets `data-titlebar="inset"` on all windows. Any new window header must use the `.window-header` class (46px tall, drag region, 84px left inset for the controls, interactive children opt out of dragging). The main toolbar keeps its own equivalent padding and drops it in full screen.

## Header and filtering

The main toolbar follows Proxyman's layout: a round capture (play/pause) button and an export/delete capsule on the left; a status capsule in the middle with a status dot, the app name, `Listening on <address>:<port>` (the LAN address when local-network access is on) and the capture state, which toggles capture when clicked, plus badges for paused breakpoints and an active filter; and capsules on the right for the filter (⌘F), the command palette, Breakpoints, Scripts, Tools, Settings, the tour and the theme. Traffic lights sit at 16,20 in the main window so they centre in the 52px bar.

The filter bar is hidden until ⌘F (or the toolbar's filter button). It stays open and tinted while any text filter or extra condition is active; Esc clears the text, then closes, and its × clears and closes. The scope select (URL, Request, Response, SSE events) is styled as the bar's label and changes the placeholder, so it is clear what is searched. Whenever any filter hides requests (text, conditions, library, application, device, domain, protocol, status or TLS errors), a summary line reads "Showing N of M" with every active filter spelled out and a Clear all button.

The sidebar footer holds a Filter (⌘⇧F) field that narrows Favorites, Applications, Devices and Domains. Applications, devices and domains can be pinned to a Favorites section at the top (pin button on hover, or Pin to Favorites in a domain's menu); pins persist in local storage (`streamglass.sidebar.favorites`, logic in `sidebar-favorites.mjs`).

## Sidebar and theme motion

The sidebar starts expanded and can be resized from its edge (width in `streamglass.sidebar.width`). Its pin button collapses it to a rail that expands on hover or focus with an animated width change; pinning again keeps it expanded (`streamglass.sidebar.pinned` in local storage, `data-sidebar-pinned` on the root). Switching light/dark adds `.theme-transition` to the root for 400 ms so colors cross-fade. Both honor `prefers-reduced-motion`.

## Keyboard and navigation

⌘K opens the command palette (every tool, rule window, setting, device and saved view). ⌘/ shows the shortcut sheet. In the traffic table, ↑/↓, Home and End move the selection, ⌘-click and ⇧-click multi-select, ⌘A selects all visible rows, ⌫ deletes with a 5-second Undo toast, and ⌘C copies the selected request as cURL. Esc in the search clears it and any extra conditions.

## Introduction

The welcome dialog keeps five animated slides, each with a title, one sentence and one visible line of detail (no
tooltip-only notes). Its last slide offers **Show me around**, which starts a tooltip walkthrough over the real
interface: nine stops (capture, proxy address, devices, applications and domains, filters, requests, inspector,
rule tools, settings and shortcuts), each highlighting its target with a thin accent outline and a soft dim.
Stops live in `walkthrough-steps.mjs` as selectors; a stop with no visible target is skipped and sidebar stops
hold the sidebar expanded. It runs in a modal dialog (Esc, End tour or a click outside ends it; arrow keys step),
honors reduced motion, and can be restarted from the command palette.

## Connect Device

Connect Device is a three-step flow: choose a platform; set up (proxy address, one-click Mac/simulator actions, and for phones and emulators a QR code that opens the LAN setup page with the certificate download and trust steps); then a live "waiting for the first request" check. For physical phones the Set up step lists approved, waiting and refused devices, and the Verify step shows a device that is being refused with Allow device and Deny, so approval never requires leaving the wizard. The setup page follows the same quiet tokens (dark/light via prefers-color-scheme), opens the iPhone or Android tab from the browser user agent, and highlights the required trust step.

## Domains

The sidebar Domains section groups captured records by host, then by up to two leading path segments, as a collapsible tree with counts (hosts and paths sorted by name so rows do not move as traffic arrives, narrowed by the sidebar filter, the 40 busiest paths per node). Encrypted CONNECT tunnels count under their host and show a lock; the lock turns green when SSL inspection is enabled. Clicking a host or path sets a single domain filter that composes with the search, conditions, library, device and application filters, and appears as a removable "Domain:" chip above the table. Hover or right-click a host for Focus, Hide, Enable SSL inspection (reuses `enableInspection`) and Copy host. Hidden hosts are excluded from the table, persisted in local storage (`streamglass.domains.hidden`, guarded by try/catch) and listed in a "Hidden domains" footer with restore. The collapsed 48px rail shows only a globe button. Pure grouping and matching live in `domain-tree.mjs`.

## JSON and body viewing

Bodies, event data, headers and logs render in Monaco (VS Code's editor), bundled locally with only the editor core, the JSON language and the basic VS Code features (find, folding, bracket matching, multi-cursor, line operations). Setup lives in `src/monaco-setup.ts`: workers are Vite `?worker` bundles served from the app origin, so the existing CSP (`script-src 'self'`, no CDN) is enough. There are no per-object Copy/Replace buttons: users select and copy text, press Cmd+F to search, and use the gutter to fold. `JsonViewer` is read-only (selection, copy, find and folding still work), pretty-prints JSON via `prepareJson` and shows anything else as plaintext. `JsonBodyEditor` is a fully editable Monaco model with JSON validation squiggles, an `aria-label` equal to its label, and a Cmd+Enter binding that forwards to the window's Continue shortcut. Both auto-size up to 560px, then scroll internally; minimap and word wrap are off, font 12px in the app's monospace stack, and folding, bracket matching and occurrence highlighting are disabled above 2 MB. Light and dark themes are generated from `--input`, `--text`, `--muted`, `--line`, `--selection` and `--accent` and re-applied when `data-theme` changes. `json-viewer.mjs` keeps its pure helpers (and tests) but the UI no longer paginates or searches itself.

## Content-type quick filters

Quick filters occupy one row above the traffic table. All clears the protocol,
content-type, status and TLS-error groups. HTTP/HTTPS/SSE, JSON/Form/XML/JS/CSS/
Document/Media/Other, status families and TLS errors remain separate toggle groups:
OR within a group, AND across groups. The strip scrolls horizontally with keyboard
focus and accessible arrow controls; Saved filters and Columns stay fixed on the right.
Content types appear in the active-filter summary and round-trip in saved filters.

Response MIME metadata determines the type, falling back to request MIME when
response metadata is absent. Submitted URL-encoded/multipart forms also match Form
when their response is JSON or XML. XHTML is Document, SVG is Media, and encrypted
CONNECT tunnels never match a content type. Missing/unknown inspectable MIME types
match Other; URL extensions are not used to guess a type. SSE streams additionally
match JSON once a retained event contains valid JSON data; mixed streams keep
matching after later heartbeat or [DONE] events. Plain-text SSE remains Other.
Classification parses at most 1,048,576 characters per event and sends only a
boolean summary flag to the table, not event bodies.

## Rule-list and Tools search

Breakpoint and script windows have a search field above the current folder's
list. Case-insensitive words match name, URL pattern, method, stage/SSE, folder,
enabled state and script text. Every word must match; special characters remain
literal. Counts show matches within the selected folder. Search never edits a
rule, changes its order or enabled state, or discards an open editor draft.

Tools has its own navigation search by tool name, category and common aliases
such as mock, throttle and decode. Empty groups are hidden. Enter opens the first
matching tool; filtering the navigation alone leaves the active tool and draft
untouched. Each window supports Cmd/Ctrl+F to focus search, Escape to clear a
nonempty query and a named clear button. Queries stay local to that window.

## Active and selected states

`active-states.css`, loaded after surface styles, owns selected surfaces, outlines,
foregrounds and selected-row semantic colors in both themes. Selection uses an
opaque blue fill and a crisp one-pixel inset boundary; hover keeps that selection
visible rather than replacing it with the neutral hover fill. Selected metadata
uses a tinted readable foreground. Keyboard focus remains a separate outer ring.

Selected devices expose their pressed state without an extra check icon. List/tab/
menu states retain their existing checkboxes, checkmarks, underline or ARIA state.
Running/error states retain semantic meaning; running labels and dots have their
own theme-aware green. See [the active-state audit](../docs/ACTIVE_STATES.md) for
coverage and validation limits.

## Quiet traffic surfaces and inspector movement

Traffic filters and selected API rows intentionally use the earlier quiet style:
active text filtering has a seven-percent accent tint and left marker, the summary
uses that same faint tint, quick-filter buttons retain their light accent tint,
and selected API rows use the original dark/light traffic-selection fill with a
left accent stripe. The stronger selected-device/navigation treatment is retained.

Switching the inspector between right and below uses a 260 ms native view
transition for the traffic and inspector panes. Only snapshot layers animate;
sidebar and toolbar remain still. The layout itself changes once. The existing
selection, scroll state, inspector size preferences and resize behavior remain
unchanged. Repeated toggles skip the prior transition, with the last request
winning. Reduced-motion preferences and unsupported environments apply the new
layout directly. Automatic narrow-window placement does not animate.

The sidebar pin/collapse button keeps a full-width header click target, with its
pressed background restricted to the icon. Device row actions use an inline end
group; hidden actions occupy no space. They are revealed on hover or keyboard
focus, while an actively pinned icon remains visible. Selected devices use the
row highlight and ARIA state, without a redundant check icon.

## Header geometry and settings entry points

Header compensation uses Electron's actual page zoom factor through a read-only
preload bridge. Native zoom changes are broadcast to every window; resize reads
are frame-coalesced and never infer zoom from outer/inner window width. Stale
initial reads cannot overwrite newer native zoom updates. The main toolbar keeps
its 52-point physical height and traffic-light inset while the window is resized.

The sidebar TLS allowlist is one full-row button that opens HTTPS / TLS directly;
other TLS-specific shortcuts use the same route. General Settings and proxy-port
errors continue to open Proxy. The approved-devices heading centers its icon and
text without changing the alignment of summaries that have descriptive paragraphs.

## Lines, surfaces and text tiers

Borders use three tokens by role: `--line-subtle` for hairlines between rows, `--line` for pane dividers,
section rules and card or dialog edges, and `--line-strong` for the edges of controls. `--text-secondary`
sits between `--text` and `--muted` for tabs and field names. Values and measured contrast are in
[the visibility audit](../docs/VISIBILITY_AUDIT.md). Keep the steps small: structure should be visible
without the interface becoming high-contrast.

## Shared message and confirmation surfaces

`Banner` (`src/Banner.tsx`) is the one row style for app-level messages under a toolbar or window header:
tone `info`, `warn` or `error`, an icon, the message, and actions on the right. Errors announce as alerts,
the others as status. `confirmAction` (`src/confirm-dialog.tsx`) replaces `window.confirm`: Cancel is focused,
Esc cancels, and destructive confirms use the tinted danger button. Do not add new native prompts or one-off
banner styles. `Modal` takes a `kind` that becomes a `modal-<kind>` class; size dialogs by that class, never by
their `aria-label`. All dialogs share the base radius, shadow and backdrop from `style.css`.

Deleting requests hides them and shows an Undo toast; the delete is sent only when the toast goes away
(timeout, dismissal or a newer message). Hovering or focusing the toast holds both. Warning, success and
danger colours come from `--q-warn`, `--q-ok` and `--danger`, which have light-theme values.

## Selection, rows and the SSL column

Selected navigation rows, pressed toggles and list selections use a soft accent tint with a 7px radius and no
outline; tabs use primary text with a 2px accent underline and no fill. Footer status items are bordered chips
with a small accent dot. Tokens stay in `active-states.css`. Traffic rows alternate `--row-a` and `--row-b`
(two close neutral greys; selection is the only blue); parity is counted from the end of the list so existing rows keep their shade when a new
request arrives at the top. Every column has the same 10px left inset. The SSL column shows a closed lock for
an encrypted tunnel, an open lock for inspected HTTPS and a dash for plain HTTP; it is shown once by default
and can be hidden from the column menu.
Traffic rows use 3px vertical padding (about 26px per row). The proxy address in the header status capsule is a button that opens Proxy settings.

## Rule table, inspector hiding and the SSE timeline

Breakpoint and script windows show one compact table (Name, Method, Matching rule, Request, Response, SSE) with
26px zebra rows. Folders are rows with a twisty, a tri-state checkbox, a count and hover actions; children indent
18px per level. Rows drag to reorder (a line above or below) or into a folder (the folder highlights); Option+Up/Down
and the row menu do the same. Sorting is disabled while a search is filtering. New and renamed folders are edited
inline in the table. There is no folder sidebar.

The inspector hides when the active Right/Below button is clicked again or its splitter is dragged to the window
edge (its size is kept). A Show inspector button appears beside the column menu, and selecting a request shows it
again. Detached inspector windows are never hidden.

The SSE timeline is a size container: above 420px it shows a horizontal four-step track and one row of stat tiles;
below that the track becomes a vertical list, tiles go two-up, and the events table drops the Received column and
shows delivery as a dot. A step that never happened reads "not reached"; a stream with no events says so instead of
showing an empty table.

In Connect a device, the certificate page (QR, URL, fingerprint) is step 1 and labelled as not the proxy; the proxy
address is step 2 with where to enter it.

# Changelog

## [Unreleased]

## [1.1.4] - 2026-11-11

### Added

- Breakpoint and script rules are a compact table with folders as expandable rows. Folders can hold folders, remember whether they are open, and have a checkbox that turns everything inside on or off. Drag rows to reorder or move them (Option+Up/Down from the keyboard); the order shown is the order rules are tried in.
- The inspector can be hidden by clicking the active Right/Below button again or dragging its splitter to the window edge. It returns when a request is selected.
- A tooltip walkthrough points at the real controls after the welcome slides (also "Show walkthrough" in the command palette). Welcome slides show a second line of detail instead of hiding it behind an info icon.
- Connect a device lists approved devices and lets you allow a waiting phone on the Verify step.

### Changed

- The SSE timeline has a status pill, a step track, stat tiles and a delivery dot per event, and reflows when the inspector is narrow.
- Connect a device labels the QR code and URL as the certificate page (step 1) and the proxy address as step 2.
- Deleting a rule folder moves its rules and folders up one level instead of ungrouping everything.

- Approved devices are forgotten 7 days after approval (Settings → Proxy, on by default; each device shows the time left). Allowing a device again renews it.
- Table rows are more compact, and the proxy address in the header opens Proxy settings.
- The lock state moved from the Request cell to its own SSL column, which can be hidden like any other column.
- Selected sidebar items, toggles and tabs use a soft tint and an underline instead of a solid outlined block; footer status items are quiet chips; table rows alternate two close greys.

- A device asking to use the proxy now opens an approval popup instead of a row under the toolbar.
- Bulk deletes, workspace and custom-field deletes, and discarding unsaved changes ask in an in-app dialog instead of a system prompt.
- Connection, update and editor messages share one banner style; dialogs share one radius, shadow and backdrop.
- Settings has Cancel, a Saving state and an inline message for an invalid port. Explanations that were only tooltips (approved devices, LAN destinations, storage, MCP approvals) are now visible text.
- Input, button and toolbar edges and pane dividers are easier to see in both themes, with row hairlines left quiet.
- A breakpoint whose connection closes while paused stays open, read-only with your draft, and warns that the device can no longer receive it.

### Fixed

- Sidebar domains and paths are ordered by name, so rows no longer move as request counts change.
- The Undo toast waits while hovered or focused, and the delete is only sent once the toast goes away.
- Sidebar devices keep their position when new traffic arrives; new devices are added at the bottom.

## [1.1.3] - 2026-11-06

### Added

- Edit JavaScript rules in the bundled Monaco editor with JavaScript syntax colors, line numbers and find.

## [1.1.1] - 2026-11-01

### Added

- Filter traffic by JSON, Form, XML, JS, CSS, Document, Media and Other in one scrollable row. JSON includes JSON-formatted SSE events, and content filters can be saved.
- Search breakpoint, script and Tools lists.
- Drag column titles to reorder them and resize columns independently, with horizontal scrolling for wide tables.
- Animate switching the inspector between right and below, respecting reduced motion.

### Fixed

- Make selected devices and navigation states clearer in both themes while keeping traffic filters and selected requests quiet.
- Keep row lines and selection across the full table pane; remove the resize separator after the last column.
- Keep the header aligned with macOS window controls during resizing and zoom changes.
- Open HTTPS / TLS directly from TLS allowlist links and align the approved-devices heading.
- Restore the sidebar collapse button's full click area, remove device selection checkmarks, and hide application counts while pin controls are visible.
- Preserve editor Find shortcuts when searching Tools.
- Keep automated verification and release builds on a supported macOS runner.
- Keep text filtering usable in narrow traffic panes and prevent queued scroll events from dismissing a newly opened request menu.

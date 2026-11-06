# Changelog

## [Unreleased]

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

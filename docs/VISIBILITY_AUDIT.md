# Visibility audit

Date: 2026-11-10. Scope: borders, separators, surfaces and label text in the desktop UI, both themes.
The goal was to make structure visible without raising overall contrast: no pure black, no saturated fills,
no heavy borders. Selection and accent values were left as they are (see [active states](ACTIVE_STATES.md)).

## What was hard to see

One `--line` token drew 151 borders of three different kinds. In the dark theme it sat at about 1.15:1
against the base surface, so:

- inputs, text areas, the sidebar filter and toolbar capsules had almost no visible edge;
- the sidebar/table/inspector dividers and dialog section rules were barely visible;
- row hairlines and pane dividers had the same weight, so nothing read as a stronger boundary.

Tab labels and field names shared `--muted` with tertiary metadata such as hosts and counts.

## Token scale

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--line-subtle` | `#1d1f24` | `#ececf1` | Hairlines between rows (table cells, list rows, history events) |
| `--line` | `#292c33` | `#dedee5` | Pane dividers, section rules, card and dialog edges |
| `--line-strong` | `#363a43` | `#c6c8d1` | Edges of controls: inputs, buttons, capsules, search fields, chips, `kbd` |
| `--text-secondary` | `#a8acb4` | `#4c5058` | Inspector tabs and field names |
| `--raised` | `#1a1b1f` | `#f1f1f4` | Dialogs, menus, raised cards |

Sidebar and panel surfaces moved one small step from the base (`#131417` dark, `#f8f8fa` light).

## Measured contrast (WCAG ratio of the two colours)

| Theme | Pair | Before | After | Token |
| --- | --- | --- | --- | --- |
| Dark | Row hairline (table, list rows) on base | 1.15 | 1.15 | `--line-subtle` |
| Dark | Pane and section divider on base | 1.15 | 1.36 | `--line` |
| Dark | Pane and section divider on panel | 1.12 | 1.32 | `--line` |
| Dark | Control edge (input, button, capsule) on its fill | 1.11 | 1.60 | `--line-strong` |
| Dark | Control edge on panel | 1.12 | 1.62 | `--line-strong` |
| Dark | Dialog/menu surface against base | 1.07 | 1.11 | `--raised` |
| Dark | Tab and field labels on panel | 4.97 | 8.09 | `--text-secondary` |
| Dark | Tertiary metadata on panel | 4.97 | 4.97 | `--muted` (unchanged) |
| Light | Row hairline (table, list rows) on base | 1.22 | 1.18 | `--line-subtle` |
| Light | Pane and section divider on base | 1.22 | 1.34 | `--line` |
| Light | Pane and section divider on panel | 1.15 | 1.26 | `--line` |
| Light | Control edge (input, button, capsule) on its fill | 1.22 | 1.67 | `--line-strong` |
| Light | Control edge on panel | 1.15 | 1.57 | `--line-strong` |
| Light | Dialog/menu surface against base | 1.13 | 1.13 | `--raised` |
| Light | Tab and field labels on panel | 4.75 | 7.63 | `--text-secondary` |
| Light | Tertiary metadata on panel | 4.75 | 4.75 | `--muted` (unchanged) |

Row hairlines were deliberately kept where they were; dividers and control edges moved up one and two steps.
Control edges remain below the 3:1 that WCAG 1.4.11 asks of a control's only boundary cue; every control here
also has a fill that differs from its surroundings and a separate focus ring, and a higher value was judged
too heavy for this design. Revisit if that trade-off changes.

## How the borders were reassigned

22 rules moved to `--line-strong` (form controls, toolbar capsules, search fields, filter conditions, chips,
platform cards, `kbd`) and 15 to `--line-subtle` (table cells and list/row separators). Table headers,
pane titles, dialog sections and cards stay on `--line`. New borders should pick by role, not by look.

## Checked and not checked

Before/after screenshots were taken with synthetic data in both themes for: main window with selection and
hover, inspector Response, filter bar, row context menu, Settings (Proxy, HTTPS / TLS), Connect a device
(platform, set up), command palette, Tools and Breakpoint rules windows. Not captured: Scripts editor,
paused breakpoint editor, toasts, error banners, detached inspector, narrow window widths.

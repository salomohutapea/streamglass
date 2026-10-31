# Active-state audit

Scope: the public Streamglass desktop UI, both dark and light themes. The source
scan reviewed 57 active/selected CSS candidates, including duplicate overrides,
semantic statuses and non-interactive demonstrations. It covered the corresponding
React state attributes and Electron native-menu check states.

## Findings and source changes

- Device/application selection used the neutral raised surface and a transparent
  child button, making it resemble hover. Selection now fills and outlines the
  full row. Selected devices expose their pressed state.
- Selection styles were spread across opaque fills, faint accent mixes and simple
  text-color changes. `active-states.css`, imported last by `main.tsx`, defines one
  theme-aware treatment with an opaque fill, inset boundary and readable foregrounds.
- Selected metadata, syntax-highlighted palette words and semantic traffic colors
  could become low contrast on the stronger fill. They have dedicated selected
  foregrounds. Plain method badges retain a quieter metadata treatment.
- Selected device/favorite/library controls and generic icon toggles lacked some
  state attributes. Their existing state is now exposed through `aria-pressed`.
- An expanded disabled traffic rule inherited dimmed text while being edited.
  Its selected header is now fully opaque; the enabled checkbox retains its meaning.
- The sidebar pin has a full-row transparent hit area in the previous design.
  Its pressed treatment is now constrained to an icon-sized button.
- A light-theme paused-stage selector overrode the initial shared treatment.
  The final selected-stage rules explicitly include the stage class and win that
  cascade without changing ordinary unselected stage colors.

## Coverage

| Surface | Treatment |
| --- | --- |
| Library, application, device and favorites navigation | Full selected fill/outline, readable counts, metadata and pressed state |
| Domain tree and applied-domain chip | Selected fill/outline; readable twisty, actions and counts |
| Inspector tabs and raw/structured toggle | Filled selection, strong text and retained tab underline |
| Protocol/content/status/TLS quick filters | Original quiet pressed tint and accent outline |
| Toolbar, pin and inspector-position toggles | Shared pressed styling and state attributes |
| Active text-filter bar and summary | Quiet accent tint and retained left marker |
| Traffic rows and sorted columns | Quiet selected API rows with left marker; sorted headings remain marked |
| Tools and Settings navigation | Shared selected surface, outline and icon colors |
| Capture pickers and body-source choices | Selected surface plus existing checkbox/radio semantics |
| Command palette and choice menus | Selected fill/outline with readable matched words and metadata |
| Breakpoint/script folders and paused items | Shared selection, legible stage/method/wait labels |
| Expanded traffic-rule headers | Strong boundary/header fill; selected disabled text remains readable |
| Custom-field editing target | Clear active boundary and location fill |
| Device platform and current connection step | Selected fill/border; retained radio/step state and number marker |
| Tour choices and demonstration selection | Consistent selected fill; existing dot/shape cues retained |
| Running network status and enabled tool pills | Labeled semantic status with theme-aware foregrounds |
| Current SSE timeline step | Filled current step with readable semantic live/warning/error indicators |
| Native menu checks and native enabled checkboxes | Platform checkmarks retained; checked boxes get a visible outline |

Hover does not replace a persistent selection with a neutral surface. Focus stays
an outer keyboard ring and is separate from selected styling. Disabled controls,
paused/suspended tools and error states retain their distinct meaning. No rule,
capture, forwarding, device or proxy-setting logic is changed by this audit.

## Traffic-surface preference

The source was subsequently adjusted to keep filters and selected API rows quiet:
seven-percent filter tint, original quick-filter tint, original traffic-row fill
and a left accent marker. Device/navigation selection retains the stronger
shared treatment and pressed state. The numeric audit below describes the
specific earlier packaged build, not these later traffic-surface preferences.

## Evidence and limits

Typechecking and static source/style inspection completed. Initial CSS previews
used an isolated profile, synthetic HTTP records and temporary styles in the old
installed app. After explicit build authorization, the local Apple Silicon release
was built and the actual packaged app was inspected in a fresh synthetic profile.
That build exercises the compiled CSS and then-present device checkmark/state attributes;
the app in /Applications was not replaced by this build.

The packaged-app computed-style audit sampled 38 representative markup states per
theme. Minimum sampled text contrast was 6.32:1 in dark mode and 5.84:1 in light
mode. The earlier paused-stage cascade issue is corrected in the built app; its
light response-stage foreground contrast is 5.96:1. No sampled text pair fell
below the 4.5:1 target.

Selection boundaries measured 4.60:1 on the dark selected fill and 3.61:1 on its
hover fill; light equivalents were 4.87:1 and 4.41:1. These are scoped computed
contrast observations and visual inspection of representative screens, not a
complete accessibility certification or screen-reader verification.

Build: `release/local/1.1.0-2026-10-30T12-29-05-319Z/`.
Actual packaged-app evidence: `release/active-state-built/` (ignored), containing
dark/light full-window and selected-device PNGs plus `contrast-audit.json`.
Earlier CSS-only preview evidence remains in `release/active-state-preview/`.

No test suites, installation or system/device setup ran for this audit. The
release uses the existing local unsigned packaging path, without Developer ID
signing or notarization.

Later source adjustments restore the full sidebar-header click target and remove
the device checkmark at user request. Hidden device actions occupy no layout
space; hover/focus reveals them without reserving empty icon slots at rest.
The recorded build above predates these source changes.

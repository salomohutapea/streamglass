# Contributing

Keep changes focused and preserve the behavior of traffic passing through the proxy. Start with the [development guide](docs/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md), and the workflow affected by your change.

## Proposing a change

For bugs, include the app version, macOS version, source or packaged build, affected client/device, minimal reproduction, and expected versus observed behavior. Mention whether TLS inspection, capture pause, breakpoints, or scripts were enabled. Use a small synthetic endpoint such as `https://api.example.test/events` rather than production captures.

For features, describe the user problem and smallest useful behavior. Explain any change to capture retention, forwarding, export formats, permissions, or setup/restoration.

Never attach real bearer tokens, cookies, private CA keys, customer data, or unredacted traffic. See [security](SECURITY.md) for sensitive reports.

## Implementation

Follow the existing layer boundaries and reuse current validators and helpers. Changes to the renderer/engine contract must cover callers in the API, editors, exports, MCP tools, and packaged engine where applicable.

Preserve duplicate headers, binary bodies, SSE ordering, and explicit incomplete-capture metadata. Capture pause, record deletion, connection drop, and proxy stop have distinct semantics; keep the UI and MCP behavior consistent. Setup changes must preserve previous proxy settings and provide restoration.

Update the relevant guide when behavior changes. Keep examples local and synthetic. Do not add credentials, captures, development profiles, generated releases, or machine-specific paths to a change.

## Verification and review

Use the [test matrix](docs/DEVELOPMENT.md#test-matrix) to select relevant checks when authorized. Add a small regression case for changed non-trivial behavior, especially streaming, message validation, restoration, and authentication. Pure documentation and trivial presentation edits do not need new tests.

A review description should state the problem, resulting behavior, checks performed, and any checks skipped. Distinguish source tests, packaged checks, and physical-device verification. Do not infer device support or distribution readiness from a local build.

Keep unrelated local work intact and avoid broad formatting or dependency changes in a focused fix.

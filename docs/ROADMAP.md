# Workbench features and follow-ups

## Implemented from the 2026-10-18 feature list

| Feature | Implementation |
| --- | --- |
| Favorite / pin | Persistent per-capture pins, row/context-menu actions, Pinned library, protection from automatic eviction within the capture budget |
| Map Local | Ordered method/wildcard rules with imported file snapshots, status, duplicate-preserving header pairs, enable/disable and reorder controls |
| Map Remote, Rewrite, Block | Ordered method/wildcard lists (Block, Map Local, Map Remote, request Rewrite, upstream, response Rewrite); per-rule header overrides for staging/production credentials, group labels, applied-rule notes on captures |
| Inspector placement | Right/below modes, persisted sizes and placement, native View menu actions |
| Platform setup menus | Certificate / Setup entries for This Mac, iOS Simulator, iOS Device, Android Emulator and Android Device |
| Network conditions | Presets/custom request latency and per-flow upload/download rates, host/device scope, asynchronous forwarding and pause bypass |
| Active-tool pills | Clickable footer indicators for enabled rules, Map Local, network conditions, SSL inspection and Mac capture; suspended indicator when relevant |
| Configurable columns | Header context menu and accessible button, 11 sortable properties, persisted visibility |
| Quick filters | HTTP/HTTPS/SSE and 1xx–5xx chips, composed with existing search/device/application filters |

See [workflows](WORKFLOWS.md) for instructions and limits. Pins and traffic tools also have [MCP access](MCP.md).

Map Local imports a file snapshot rather than watching it. It has a 32 MiB combined fixture-body budget and requires bounded request buffering while active. Network conditions are application-level, per-flow rate simulation; they do not simulate packet loss, shape opaque TLS tunnels, or set an aggregate device bandwidth ceiling.

## Additional testing tools now implemented

The [testing tools guide](TESTING_TOOLS.md) covers SSE timing and termination diagnostics; context-only, delayed-event, disconnect and one-shot error scenarios; structural capture comparison; complete capture-to-mock conversion with timed SSE events; explicit request editing/replay; previewed redacted exports; named configuration workspaces; and optional decoded response views/editing with re-encoding.

Automatic app-specific decryption is deferred: backend-selected crypto artifacts differ by app version and platform. Configurable primitive/custom codecs are available without claiming compatibility with a downloaded protocol bundle.

## Daily tools now implemented

The [daily debugging guide](DAILY_TOOLS.md) covers immutable named capture archives with streaming `.sgsession` import/export and archived/live comparison; configured search-journey correlation and waterfall timing; JSONPath watches; background assertions and MCP results; bounded sequential repeated replay with cancellation; and persisted saved views with capture notes and highlights. Map Remote and WebSocket inspection remain outside the current scope.

## Follow-ups, not implemented

1. Broader interchange support for HAR and legacy session imports; `.sgsession` capture archives are implemented.
2. Fixture directories and optional file watching with scoped path resolution.
3. Revision checks for every concurrent desktop/MCP rule edit; workspace restoration is atomic, but individual editors still use fetch-latest conflict handling.
4. Full SSE transport recording, including unretained heartbeat/comment frames, beyond retained event fixtures.

Mitmproxy offers [local mapping options](https://docs.mitmproxy.org/stable/concepts/options/) and [replay features](https://docs.mitmproxy.org/stable/overview/features/). Reuse must preserve Streamglass's pause, validation and incremental SSE contracts. Upstream availability does not mean a capability is integrated here.

Use [feature contracts](FEATURE_CONTRACTS.md) and the [source/test map](AGENT_GUIDE.md) when implementing follow-ups. Only the user's requested scope authorizes work.

# Streamglass

A local desktop HTTP and SSE debugging proxy for developers working on Mac, iOS simulators and devices, and Android emulators and devices. The explicit product brief calls for a compact Apple-style utility with request navigation, a dense traffic table, a resizable detachable inspector, wildcard breakpoint rules, JavaScript hooks, exports, device setup, and an opt-in TLS domain allowlist.

The main task is inspecting real traffic and editing paused requests, responses, and events before forwarding them. No synthetic traffic is shown. Backend connection errors, pending flows and recording state must be visible. Device configuration uses the Electron helper and its confirmation flow. This document derives directly from the supplied brief; no additional product assumptions were introduced.

HTTPS connections appear as encrypted CONNECT tunnels before SSL inspection, showing only destination, connection state, and device. The inspector can add the destination to the TLS allowlist; trusting the local certificate and reconnecting the client are required to inspect subsequent requests, responses, events, and breakpoints. Opaque tunnel rows do not offer request exports.

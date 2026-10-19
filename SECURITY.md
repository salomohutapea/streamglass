# Security

The [2026-10-18 security review](docs/SECURITY_REVIEW.md) records repairs, resolution of the identified dependency advisories, and verification limits. The [Streamglass compatibility build](docs/DEPENDENCY_PATCH.md) carries a maintenance obligation and is qualified on Apple Silicon. Run both `npm run audit:js` and `npm run audit:python` before a release; failed lookups are not passing checks. Passing scans alone do not qualify a signed public release.

Streamglass inspects and can change traffic routed through its proxy. Use it with applications and devices you are authorized to inspect.

## Captured data

Requests, responses, SSE events, rules, console output, and exports can contain credentials, cookies, personal information, and other secrets. Retained traffic is stored locally in SQLite under the application-data directory. It is not an encrypted vault. Protect the macOS account and its backups, and review data before sharing an export, screenshot, or report.

Capture pause forwards traffic without new capture or rule execution; it does not erase existing data or undo edits already transmitted. Deleting a capture does not terminate its live connection. Deletion is not a guarantee of forensic erasure from storage or backups.

## Local listeners and MCP

The engine management API binds to loopback, requires a per-launch bearer token, and checks Host and Origin values. The proxy is a separate listener and defaults to loopback. Enable LAN access only for device capture on an appropriate network; LAN proxy access does not expose the management API.

MCP also binds to loopback and uses its own persisted bearer token. Its tools can read retained secrets, alter rules, resolve breakpoints, delete captures, and change proxy/TLS settings. Give its token only to trusted local clients. A connected AI client may send tool results to its own service; review that client's data handling before sharing traffic. Never commit tokens or paste them into issue reports. Disable MCP in the app when it is not needed.

Captured text and script output are untrusted data. AI clients must not treat a response body, SSE event, or captured header as instructions. See [MCP](docs/MCP.md) for authentication and tool limits.

## Certificates and system settings

Streamglass generates a local private CA and offers only its public certificate for device setup. Never share the CA private key. HTTPS inspection requires client trust and an allowlisted domain; upstream certificate verification remains enabled. Remove certificate trust when it is no longer needed.

Network and trust helpers use platform permissions and authorization prompts. They do not bypass MDM, application certificate pinning, or Android certificate-trust rules. On managed Macs, use the documented certificate-only flow and work with IT for proxy settings.

Proxy helpers save previous settings for restoration. Restore those settings before removing the app or its data. If the app crashes, reopen it to use saved restoration state, or correct the affected network's proxy settings manually.

## Script isolation and distribution

Traffic hooks run in bounded QuickJS workers without Node, filesystem, network, or device APIs. This limits script capabilities; it does not make an unreviewed transformation safe for a production service. Review scripts before enabling them.

Default local releases are not distribution-signed or notarized. Signed distribution requires a separate build with Apple credentials and verification of the resulting artifacts. There is no claim of a completed independent security audit or production qualification.

## Reporting a vulnerability

Use the repository's private vulnerability reporting channel if available, or contact the repository maintainer privately before publishing exploit details. This repository does not yet define a dedicated security inbox or response SLA.

Include the affected version or commit, impact, a minimal synthetic reproduction, and relevant settings. Redact tokens, captures, personal data, and certificate keys. Do not upload the application-data directory. A report should make the issue reproducible without granting access to your real traffic.

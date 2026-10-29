# Security

The [security review](docs/SECURITY_REVIEW.md) records repairs, resolution of identified dependency advisories, and verification limits, including the 2026-10-29 hardening of default settings, LAN access and AI (MCP) access. The [Streamglass compatibility build](docs/DEPENDENCY_PATCH.md) carries a maintenance obligation and is qualified on Apple Silicon. Run both `npm run audit:js` and `npm run audit:python` before a release; failed lookups are not passing checks. Passing scans alone do not qualify a signed public release.

Streamglass inspects and can change traffic routed through its proxy. Use it with applications and devices you are authorized to inspect, with test accounts, and on staging or test services where you can.

## Default settings

A new installation starts with the narrowest settings:

| Setting | Default | Turn on in |
| --- | --- | --- |
| LAN access (devices on the network using the proxy) | Off: the proxy listens on `127.0.0.1` only | Settings → Proxy |
| AI access (MCP server) | Off | Tools → Agent (MCP) |
| HTTPS inspection | No domains | Settings → HTTPS / TLS |

Existing profiles keep their stored values. Turn LAN access and MCP off again when you finish with them.

## Captured data

Requests, responses, SSE events, rules, console output, and exports can contain credentials, cookies, personal information, and other secrets. Retained traffic is stored locally in SQLite under the application-data directory. It is not an encrypted vault. Protect the macOS account and its backups, and review data before sharing an export, screenshot, or report. Captures are cleared when the engine starts and stops; saved capture sessions and exports remain until you delete them, so delete them when you no longer need them.

Retention is bounded. Captures of HTTPS-inspected domains have their own budget (5000 captures or a size set in Settings → Storage: 1 GiB by default, 256 MiB to 4 GiB), separate from other traffic (1000 captures or 256 MiB); the oldest unpinned capture is evicted first. Decoding for inspection, SSE streams and Rewrite rules is bounded so that a small compressed body cannot expand without limit in memory. Retention limits never truncate forwarded bytes.

Do not store real passwords or production tokens in Map Remote, Rewrite or Map Local rules. Rules persist in the profile and in saved workspaces.

Capture pause forwards traffic without new capture or rule execution; it does not erase existing data or undo edits already transmitted. Deleting a capture does not terminate its live connection. Deletion is not a guarantee of forensic erasure from storage or backups.

## Local listeners

The engine management API binds to loopback, requires a per-launch bearer token, and checks Host and Origin values. The proxy is a separate listener and binds to loopback unless LAN access is on. LAN proxy access never exposes the management API or MCP.

### LAN access

LAN access is meant for physical test devices on a trusted network. While it is on:

- **Only approved devices can use the proxy.** A connection from another address on the network is refused, and the main window asks whether to allow that device. Approved device addresses are listed in Settings → Proxy, where you can remove them. Approval is by IP address: a different device that later takes the same address on the network is treated as approved, so keep LAN access for trusted networks and turn it off after use.
- **Devices cannot reach this Mac's own services or private networks.** Requests from LAN devices to loopback, private (RFC 1918), link-local, shared (CGNAT) and other non-public addresses are refused. This covers servers listening on the Mac and internal services reachable through a VPN the Mac is connected to. Host names are checked by every address they resolve to, and the address actually connected is checked again. To let devices reach a specific internal host or range, list it under Settings → Proxy → LAN destinations. Internal services published on public IP addresses through a VPN cannot be told apart from internet services and are not blocked.
- Loopback clients are not restricted: apps on this Mac, iOS simulators, the Android emulator and `adb reverse` connections.

### Phone setup site

While LAN access is enabled, a separate read-only HTTP listener (proxy port + 1, or `STREAMGLASS_SETUP_PORT`) helps phones install the certificate. It answers only requests addressed to one of this Mac's LAN IP addresses, which rejects requests sent through other host names (DNS rebinding). It accepts only GET and HEAD, serves a fixed set of routes (`/`, `/cert.pem`, `/cert.crt`, `/streamglass.mobileconfig`, `/proxy.pac`), rejects other paths, and reads no request data beyond the path and Host. Its only dynamic content is the Mac LAN address, proxy port and certificate fingerprint. It serves the public CA certificate only and refuses any file containing private key material; the iOS profile is unsigned and carries only the certificate payload. It exposes no captured data and no management or MCP access, and it stops when LAN access is turned off.

The setup page and Connect device in the app both show the certificate's SHA-256 fingerprint. Check that they match before trusting the certificate on a device.

## AI assistants (MCP)

The MCP server is off until you enable it. It binds to loopback and uses its own persisted bearer token; it rejects browser Origin headers. Give its token only to trusted local clients, never commit it or paste it into issue reports, and disable MCP when it is not needed.

A connected AI client can read retained traffic, including secrets, and may send tool results to its provider. Use only AI clients and accounts your organization approves for this data. Captured text and script output are untrusted data: AI clients must not treat a response body, SSE event or header as instructions.

Actions that send data elsewhere or widen what Streamglass can read wait for you to click **Allow** in the app. Deny is the default, and a request nobody answers within two minutes is refused:

| MCP action | Asks when |
| --- | --- |
| Send a request (`replay_request`, `start_replay_job`) | Every time |
| Redirect traffic (Map Remote rules, edited breakpoint URLs) | The target server has not been approved before. Approved servers are listed in Tools → Agent (MCP), where you can remove them |
| Unlock HTTPS inspection for more sites (`update_settings` `tlsDomains`) | Any domain is added |
| Run JavaScript on traffic (`upsert_rule`) | The script is new or changed |
| Load a configuration workspace | Every time |

AI clients cannot add broad HTTPS patterns: `*`, `*.com`, `api.*` and other patterns without a literal domain name are refused. Patterns you type in Settings are not limited this way. Other MCP tools can still read captures, delete captures, change breakpoints, Rewrite, Block and Map Local rules, and pause or stop the proxy without a prompt. See [MCP](docs/MCP.md) for authentication and tool limits.

## Certificates and system settings

Streamglass generates a local private CA and offers only its public certificate for device setup. Never share the CA private key. HTTPS inspection requires client trust and an allowlisted domain; upstream certificate verification remains enabled. Remove certificate trust when it is no longer needed.

Network and trust helpers use platform permissions and authorization prompts. They do not bypass MDM, application certificate pinning, or Android certificate-trust rules. On managed Macs, use the documented certificate-only flow and work with IT for proxy settings.

Proxy helpers save previous settings for restoration. Stopping the proxy restores the Mac's saved system proxy settings; Mac capture reapplies them when the proxy starts again. Quitting restores them too. If the app crashes, reopen it to use saved restoration state, run the uninstall script, or correct the affected network's proxy settings manually. Android and other devices keep the proxy they were given until you restore it in Device Setup or on the device.

## Removing Streamglass

`scripts/uninstall.sh` removes Streamglass for the current Mac user. It quits the app, restores the network proxy settings Streamglass changed, removes trust in this installation's CA and its copy from the login keychain, deletes the application-data directory (captures, rules, scripts, workspaces, the CA private key and the MCP token) and deletes the app. Run it as the user, not as root; `--keep-app` keeps the application and `--yes` skips the confirmation. It cannot reach other devices: remove the Streamglass profile or certificate from phones and simulators, restore their proxy settings, and remove the MCP entry from AI clients yourself.

## Script isolation and distribution

Traffic hooks run in bounded QuickJS workers without Node, filesystem, network, or device APIs. This limits script capabilities; it does not make an unreviewed transformation safe for a production service. Review scripts before enabling them.

Default local releases are not distribution-signed or notarized and do not use the hardened runtime. Signed distribution requires a separate build with Apple credentials, which enables the hardened runtime and notarization, and verification of the resulting artifacts. Install only builds from a source and commit you have reviewed. There is no claim of a completed independent security audit or production qualification.

## Reporting a vulnerability

Use the repository's private vulnerability reporting channel if available, or contact the repository maintainer privately before publishing exploit details. This repository does not yet define a dedicated security inbox or response SLA.

Include the affected version or commit, impact, a minimal synthetic reproduction, and relevant settings. Redact tokens, captures, personal data, and certificate keys. Do not upload the application-data directory. A report should make the issue reproducible without granting access to your real traffic.

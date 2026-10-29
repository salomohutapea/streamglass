# Security hardening review — 2026-10-18

Status: **the identified dependency blockers are resolved for the Apple Silicon candidate** using the reviewed [compatibility build](DEPENDENCY_PATCH.md). The follow-up OSV scan checked 58 distributions with zero active findings; the custom mitmproxy version was queried as upstream 12.2.3. This remains a partial source review and regression exercise, not an independent penetration-test certificate. Repository creation and publication have not been performed. A [2026-10-29 hardening](#2026-10-29-hardening) section below covers safer defaults, LAN and AI-client approvals, removal tooling and further dependency updates.

## Scope and trust model

Reviewed application entry points: Electron IPC and custom app protocol, management HTTP API, MCP listener/tool boundary, QuickJS worker, capture import/export, proxy body inspection, and device-setting lifecycle. Actors include a hostile upstream server, an untrusted page, a LAN proxy client, an imported archive author, and an authenticated local AI client. Sensitive assets include retained traffic, proxy credentials, the CA private key, MCP token, and macOS network settings.

The loopback management API uses a random per-launch bearer token, exact Host checks, and an Origin allowlist. MCP has a separate token and rejects browser Origin headers. Electron disables Node integration, enables context isolation/sandboxing, blocks navigation/new windows, and validates IPC senders. Scripts receive serialized data in QuickJS with memory/time limits. Upstream TLS verification stays enabled. These controls were reviewed in source; relevant regression tests exercise their supported boundaries. The authenticated local user/agent is intentionally powerful and can redirect/replay traffic. Captured content remains untrusted data even when returned through MCP.

The CSO helper could not create a snapshot because this folder is not a Git working tree. Its qualified Docker scanner/runtime profiles were also unavailable. No helper-backed report, isolated exploit-verification bundle, historical-secret scan, or comprehensive static scanner verdict is claimed. Direct source review and public advisory checks were used separately. A narrow credential-pattern scan of 154 source/documentation files found no private-key blocks, AWS access-key IDs, GitHub tokens, or OpenAI project keys; this is not exhaustive secret detection. Profiles, captures, binaries, dependency trees, and build artifacts were excluded.

## Repairs

| Finding | Impact and evidence | Change |
| --- | --- | --- |
| SG-01: unbounded decoded inspection bodies | A small compressed HTTP response could expand well beyond the retained-body limit when `message_value` called mitmproxy's unrestricted text decoder. Remote response content controls expansion. Streaming wire-size limits alone do not protect decoded memory. | Bounded gzip/deflate/Brotli/Zstandard preview decoding; large decoded bodies show an explicit unavailable marker, preserve wire bytes, and disallow body edits. Synthetic compressed, charset, malformed, concatenated-gzip, and unchanged-byte tests cover the repair. |
| SG-02: ambiguous authorization syntax | The management API accepted a raw correct token without the Bearer scheme. This was not an authentication bypass: the secret was still required. Non-ASCII token comparison could raise before normal error handling. | Require the Bearer prefix and compare UTF-8 bytes. Boundary tests cover missing, raw, wrong, non-ASCII tokens, hostile Host/Origin, and query token misuse. |
| SG-03: stale configuration replacement | Concurrent editor/MCP writes could overwrite another client's rules, Map Local fixtures or network profile; editing also moved a rule to the end and changed priority. | Persisted revision preconditions, 428 for missing revision, 409 for stale writes, retained editor drafts, and stable rule order. API, frontend helper, and MCP conflict tests cover the contract. |
| SG-04: dependency chain with known advisories | Initial npm audit reported 8 affected package nodes from one `sprintf-js` advisory in the development packaging chain. Initial Python lookup flagged 7 installed distributions. | Updated mitmproxy 12.2.1 → 12.2.3 and compatible dependencies, pinned aiohttp 3.14.5, and pinned `global-agent` 4.1.3 via npm override to remove the vulnerable logger chain. The packaging downloader's `initializeProxy()` compatibility smoke check passes. |

The npm override remains until electron-builder updates its downloader dependency. Do not downgrade electron-builder merely to make the audit count disappear. The advisory describes attacker-controlled format-string precision; no path from captured traffic to the build logger was established. See [the advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) and [global-agent's major-version notes](https://github.com/gajus/global-agent/releases/tag/v4.0.0).

The update check is the only Node request that leaves the Mac; other Node requests go to the local engine on 127.0.0.1. It asks GitHub for `Accept-Encoding: identity`, so Node's decoders never handle a compressed network response. This mitigates the Brotli out-of-bounds write CVE-2026-111497 from the [October 2026 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). Electron 44.8.0 bundled Node 24.22.0, and the fix is in 24.22.1. Electron was upgraded to 44.10.0 on 2026-10-29, which bundles Node 24.22.1, so the Node decoders are patched as well as unused for network responses. Captured traffic is decoded by the Python engine, not Node.

SSE retry metadata also uses a bounded safe-integer conversion. A frame containing thousands of retry digits no longer raises Python's integer conversion error and interrupts capture; the original frame still forwards unchanged. A regression covers oversized values and long leading-zero values.

## Historical dependency findings and resolution

`npm audit --json --ignore-scripts` after repair: **0 reported vulnerabilities**, including development dependencies. The first OSV pass flagged the four distributions below. They have since been replaced by cryptography 50.0.2, h2 4.4.1, msgpack 1.2.3 and tornado 6.5.10, with pyOpenSSL 26.4.0. A follow-up scan found zero active advisories. GHSA and PYSEC entries can represent the same CVE; do not count aliases as separate vulnerabilities.

| Installed dependency | Remaining advisories / fixed version | Reachability assessment |
| --- | --- | --- |
| cryptography 48.0.1 | [PKCS#7 oracle](https://osv.dev/vulnerability/GHSA-g6cj-pr64-35w5), fixed 50.0.0; [path-building expansion](https://osv.dev/vulnerability/GHSA-jwv3-5hgf-82ww), [DNS constraint verification](https://osv.dev/vulnerability/GHSA-m2h6-j472-rp4c), fixed 49.0.0 | Streamglass uses cryptography through its TLS/codec dependencies. The named PKCS#7 and verifier APIs were not established as reachable from a Streamglass request in this review; this does not certify them unreachable. |
| h2 4.3.0 | [duplicate Host request smuggling](https://osv.dev/vulnerability/GHSA-6hr6-w5qg-qmwg), fixed 4.4.1 | HTTP/2 is part of the inspected proxy path. Treat as the primary unresolved network-facing release risk; exploitability through mitmproxy's extra validation was not reproduced. |
| msgpack 1.1.2 | [Unpacker reuse after error](https://osv.dev/vulnerability/GHSA-6v7p-g79w-8964), fixed 1.2.1 | Streamglass archives use JSON; no direct MessagePack import endpoint was found. Transitive mitmproxy usage was not comprehensively proven unreachable. |
| tornado 6.5.5 | Ten GHSA records covering client redirects/credentials, response limits, parsing, static paths and cookies; see repeatable audit output. Fixed releases range 6.5.6–6.5.9. | Streamglass runs aiohttp and mitmproxy DumpMaster, not the mitmweb Tornado server. No direct Tornado endpoint was found, but the package is included by the dependency and packaging closure. |

Upstream mitmproxy 12.2.3's bounds still exclude the fixed releases. Streamglass now maintains the explicit metadata-only `12.2.3+streamglass.2` compatibility build. Normal pip resolution installs the fixed versions and `pip check` passes. No advisory suppression or dependency bypass is used. See [provenance, exact changes and maintenance obligations](DEPENDENCY_PATCH.md); upstream does not support this combination on Streamglass's behalf.


## 2026-10-29 hardening

Status: the changes below are implemented in source. This is the project's own hardening pass, a partial source review and regression exercise like the one above, not an independent audit or penetration test. Captured data is still stored unencrypted, and local builds are still not distribution-signed (see [open items](#open-items)).

| Finding | Impact and evidence | Change |
| --- | --- | --- |
| SG-05: broad defaults | New profiles listened on all interfaces, so any device on the network could route traffic through the proxy, and the MCP server could be enabled without a deliberate choice. | LAN access defaults to `127.0.0.1` and MCP defaults to disabled (`mcp.json` starts with `enabled:false` and no approved redirects). Existing profiles keep their stored values. |
| SG-06: any LAN client could use the proxy | With LAN access on, the proxy accepted every client on the network. | `backend/lan_guard.py` refuses a non-loopback client until the user approves its IP address (`settings.lanDevices`, `/api/lan-devices`). Refused devices appear as a request with an Allow device or Deny banner (at most 32, not persisted). Loopback clients, such as simulators and `adb reverse`, are never restricted. Approval is by address: another device that takes the same address inherits it, so use LAN access on trusted networks only. |
| SG-07: approved LAN devices could reach internal networks | A LAN client could ask the proxy to connect to this Mac's own services, private networks or a cloud metadata address, using the Mac as a stepping stone. | The `server_connect` and `server_connected` hooks refuse non-global destinations: loopback, RFC 1918, link-local (including 169.254.169.254), CGNAT, IPv6 unique-local and link-local, multicast and reserved. Every address a name resolves to is checked, and the connected peer is checked again to defeat DNS rebinding. Users can allow specific hosts, IPs or CIDR ranges in Settings → Proxy → LAN destinations (`*`, `*.*` and `/0` rejected; at most 100). Internal services on public IP addresses reached through a VPN are not detected. |
| SG-08: phone setup site and certificate trust | The setup site answered any `Host` header, so a DNS-rebinding page could read it, and users had no way to verify the certificate they were installing. | The site answers only the Mac's own LAN IPv4 addresses (with or without the setup port) and returns HTTP 421 otherwise. The setup page and Connect device show the CA's SHA-256 fingerprint for comparison. |
| SG-09: MCP actions without user consent | An authenticated AI client could send requests, redirect traffic with its credentials to another server, unlock HTTPS inspection for more sites, install JavaScript that rewrites URLs and headers, or replace the whole configuration. | These actions wait for the user to click Allow in the main window (Deny default, refused after 120 s, at most 8 queued): `replay_request` and `start_replay_job`; newly enabled Map Remote redirect servers, including through `set_traffic_rule_group_enabled` and traffic-tools edits; `resolve_pending` edits to another scheme, host or port; new `tlsDomains`; new or changed rule JavaScript; and `load_workspace`. Approved servers persist in `mcp.json` (at most 200) and can be removed in Tools → Agent (MCP). MCP also refuses TLS patterns whose last two labels are not literal. Reads, deletes, other rule edits, pause and proxy stop remain unprompted. See [MCP](MCP.md#actions-that-need-your-approval). |
| SG-10: proxy stop left the Mac pointing at a dead proxy | Stopping the listener while Mac capture was on left system proxy settings aimed at Streamglass. | Stopping the proxy, including through MCP, restores saved Mac proxy settings that still point at Streamglass within about 3 seconds. Mac monitoring reapplies them when the proxy starts. |
| SG-11: unbounded decoding and unbounded inspected retention | Compressed SSE Brotli streams could request large output per step. Rewrite body replacement could decode a small compressed body past its bound. Captures of inspected domains were exempt from eviction, so retention could grow without a limit. | Brotli SSE decoding requests at most 64 KiB of output per step. Rewrite decodes compressed bodies with the bounded decoder and skips any whose decoded size exceeds 8 MiB, forwarding the original bytes. Inspected captures have their own budget (5000 captures and a user-set size of 1 GiB by default, 256 MiB to 4 GiB; oldest unpinned first), separate from the 1000 captures and 256 MiB for other traffic, so one cannot evict the other. Retention limits never truncate forwarded data. |
| SG-12: no removal path | Removing the app left captures, the CA private key, the MCP token, keychain trust and system proxy settings behind. | `scripts/uninstall.sh` (run as the Mac user, not root; `--keep-app`, `--yes`; `STREAMGLASS_DATA_DIR` override) quits the app, restores saved proxy settings and any service still pointing at `127.0.0.1:<proxy port>`, removes trust and the login-keychain copy of this installation's CA matched by SHA-1 rather than name, warns about a System keychain copy and about Android devices, deletes the application-data directory and app-related preferences and caches, and deletes the app. Device-side CA copies and AI-client MCP entries must be removed by hand. |
| SG-13: dependency advisories | The October 2026 advisories listed below affected the installed set, and Monaco vendors a DOMPurify 3.4.15 copy with critical advisories (GHSA-p98j-92pf-mc4p and related). | See the list below. |

Dependency changes:

- Electron 44.8.0 → 44.10.0 (Node 24.22.1, with the October 2026 Brotli fix).
- Python: Brotli 1.2.0 → 1.2.1 (CVE-2026-111497, GHSA-9v8h-qqgm-4m35), certifi 2026.7.22 → 2026.10.23 (GHSA-6q48-6c7w-9gw2), tornado 6.5.10 → 6.6 (GHSA-pcg2-g6cj-q92c, GHSA-pw9p-v7r6-gx4p, GHSA-r4j5-9xpp-3985) and setuptools 84.0.0 → 84.2.1 (GHSA-xmj3-9gf7-h52w). The compatibility build is now `12.2.3+streamglass.2`, which adds `Brotli==1.2.1` and tornado 6.6; see [the recipe](DEPENDENCY_PATCH.md).
- npm: transitive body-parser and fast-uri advisories fixed by a lockfile update. Monaco's bundled DOMPurify is replaced: the app adds `dompurify@3.4.17` with an npm `overrides` entry and a Vite `resolve.alias` in `frontend/vite.config.ts` that redirects Monaco's `./dompurify/dompurify.js` to the patched package. The built bundle contains only DOMPurify 3.4.17.
- On 2026-10-29, after these updates, `npm audit` reported 0 vulnerabilities and `npm run audit:python` reported no active findings for the installed environment (mitmproxy audited as upstream 12.2.3), and `pip check` passed. Re-run both before each release.

### Open items

- Local builds are unsigned and use ad-hoc signing without the hardened runtime, and are not notarized. The signed build path already enables the hardened runtime and notarization; adding Developer ID signing, notarization and the hardened runtime to local builds is not done.
- Captures are stored unencrypted in the local SQLite database. Encryption at rest is not implemented; see [security](../SECURITY.md#captured-data) for handling guidance.
- Approval of LAN devices is by IP address, and the destination guard cannot see internal services on public addresses behind a VPN.

## Reproduce the checks

```sh
npm ci
python3 -m venv .venv
.venv/bin/python scripts/prepare_mitmproxy.py
.venv/bin/python -m pip install --find-links build/wheels -c constraints-macos.txt -e '.[package]'
npm run audit:js
npm run audit:python
.venv/bin/python -m pip check
npm run typecheck
npm test
npm run build:ui
npm run test:desktop
```

The Python checker sends only public package names/versions to OSV, never source, profiles, tokens, or capture data. It exits 0 with no active matches, 1 with findings, and 2 when assessment fails. It checks the installed environment and audits local builds under their public upstream version, so install the candidate first. `constraints-macos.txt` records the tested macOS dependency set and participates in setup's cache key; it is not a security approval or a wheel-hash lock. JavaScript uses `package-lock.json`. Refresh both alongside each reviewed dependency update.

Normal local tests use synthetic data and ephemeral listeners. A passing suite does not establish security of all real-device clients, crash recovery, signing/notarization, binary dependencies, or every source path. Keep those gates explicit in [release qualification](RELEASE.md).

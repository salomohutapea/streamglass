# Security hardening review — 2026-10-18

Status: **the identified dependency blockers are resolved for the Apple Silicon candidate** using the reviewed [compatibility build](DEPENDENCY_PATCH.md). The follow-up OSV scan checked 58 distributions with zero active findings; the custom mitmproxy version was queried as upstream 12.2.3. This remains a partial source review and regression exercise, not an independent penetration-test certificate. Repository creation and publication have not been performed.

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

SSE retry metadata also uses a bounded safe-integer conversion. A frame containing thousands of retry digits no longer raises Python's integer conversion error and interrupts capture; the original frame still forwards unchanged. A regression covers oversized values and long leading-zero values.

## Historical dependency findings and resolution

`npm audit --json --ignore-scripts` after repair: **0 reported vulnerabilities**, including development dependencies. The first OSV pass flagged the four distributions below. They have since been replaced by cryptography 50.0.2, h2 4.4.1, msgpack 1.2.3 and tornado 6.5.10, with pyOpenSSL 26.4.0. A follow-up scan found zero active advisories. GHSA and PYSEC entries can represent the same CVE; do not count aliases as separate vulnerabilities.

| Installed dependency | Remaining advisories / fixed version | Reachability assessment |
| --- | --- | --- |
| cryptography 48.0.1 | [PKCS#7 oracle](https://osv.dev/vulnerability/GHSA-g6cj-pr64-35w5), fixed 50.0.0; [path-building expansion](https://osv.dev/vulnerability/GHSA-jwv3-5hgf-82ww), [DNS constraint verification](https://osv.dev/vulnerability/GHSA-m2h6-j472-rp4c), fixed 49.0.0 | Streamglass uses cryptography through its TLS/codec dependencies. The named PKCS#7 and verifier APIs were not established as reachable from a Streamglass request in this review; this does not certify them unreachable. |
| h2 4.3.0 | [duplicate Host request smuggling](https://osv.dev/vulnerability/GHSA-6hr6-w5qg-qmwg), fixed 4.4.1 | HTTP/2 is part of the inspected proxy path. Treat as the primary unresolved network-facing release risk; exploitability through mitmproxy's extra validation was not reproduced. |
| msgpack 1.1.2 | [Unpacker reuse after error](https://osv.dev/vulnerability/GHSA-6v7p-g79w-8964), fixed 1.2.1 | Streamglass archives use JSON; no direct MessagePack import endpoint was found. Transitive mitmproxy usage was not comprehensively proven unreachable. |
| tornado 6.5.5 | Ten GHSA records covering client redirects/credentials, response limits, parsing, static paths and cookies; see repeatable audit output. Fixed releases range 6.5.6–6.5.9. | Streamglass runs aiohttp and mitmproxy DumpMaster, not the mitmweb Tornado server. No direct Tornado endpoint was found, but the package is included by the dependency and packaging closure. |

Upstream mitmproxy 12.2.3's bounds still exclude the fixed releases. Streamglass now maintains the explicit metadata-only `12.2.3+streamglass.1` compatibility build. Normal pip resolution installs the fixed versions and `pip check` passes. No advisory suppression or dependency bypass is used. See [provenance, exact changes and maintenance obligations](DEPENDENCY_PATCH.md); upstream does not support this combination on Streamglass's behalf.

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

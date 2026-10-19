# Pre-1.0.0 hardening result

Reviewed 2026-10-18. **Hardening changes implemented; the follow-up dependency repair removed the four identified advisory blockers for Apple Silicon.** See [the compatibility build](DEPENDENCY_PATCH.md) for provenance and maintenance. No repository was initialized, version bumped, release published, or installed application replaced during this pass. Signed artifact and real-device qualification remain separate release gates.

## Result by area

| Area | Result |
| --- | --- |
| Security | Bounded decompressed inspection and SSE retry parsing, stricter token syntax, safe rule/configuration revision checks, dependency updates, and sensitive-file ignores. [Findings and limits](SECURITY_REVIEW.md). |
| Architecture | Practical SOLID review, stable rule precedence, persisted concurrency control for rules and Traffic Tools, and documented extension boundaries. Large orchestration modules and version-coupled engine patch remain explicit design costs. [Review](ARCHITECTURE_REVIEW.md). |
| AI agents | 51 MCP tools cover capture inspection, gradual SSE events, breakpoints, scripts, replay, Map Local, network profiles, archives and workspaces. Bounded output, continuation cursors, actionable conflict errors, annotations, and package-derived version. OS setup, filesystem operations and codec secrets remain desktop-only. [Agent workflows](MCP.md). |
| Documentation | Human onboarding, contributor guide, source/API change map, feature invariants, test matrix, security review and release checklist. Local links across 17 Markdown documents resolved during the pass. [Start here](../README.md). |
| Tests | New compressed-response forwarding, authorization/Host/Origin, concurrent writes, MCP pagination, stable ordering and SSE edge cases supplement existing end-to-end scenarios. Test counts describe executed cases, not a line/branch coverage percentage. [Matrix](DEVELOPMENT.md#test-matrix). |

## Executed verification

Local environment: macOS ARM64, Node 25.9.0 and Python 3.14.8. The declared minimum versions were not separately exercised. Tests used temporary profiles, synthetic traffic and local fixture servers; no live capture database or CA was used.

| Check | Final result |
| --- | --- |
| TypeScript | Passed |
| JavaScript service/helper suite | 110 passed |
| Python engine/API/integration suite | Follow-up dependency candidate: 152 passed, including HTTP/2 and wheel provenance/audit tests |
| Desktop integration | 5 passed |
| UI production build | Passed |
| PyInstaller engine build | Passed |
| Frozen-engine smoke | Passed: authenticated startup, byte-exact gzip forwarding, bounded decoded preview and SSE capture |
| Python dependency consistency (`pip check`) | Passed |
| Clean dependency resolution | Passed with `--ignore-installed --dry-run`; normal resolver accepted the compatibility wheel and all fixed versions |
| Single-command setup | `npm run setup` passed with the local wheel recipe |
| npm advisory audit (including development packages) | 0 reported vulnerabilities after repair |
| OSV installed-Python audit | Follow-up: 58 distributions checked, zero active findings; mitmproxy local label mapped to upstream version |

The initial 10-second frozen-engine startup allowance expired; a 60-second allowance passed. The smoke script now uses the longer bound. Initial socket-based tests required running outside the restricted sandbox. The final test runs had no skipped cases. Some large-body fixtures emit aiohttp resource/performance warnings; they did not fail assertions.

The dependency follow-up repeated the 110 JavaScript tests, five desktop tests, TypeScript check, engine build and frozen-engine smoke against the fixed versions. A new HTTP/2 reset test initially exposed a synthetic-origin race: responding after a reset closed the fixture's shared connection. The fixture now coordinates the first response before sending the reset; the unchanged response-isolation assertion passed eight repeats and the full 152-test suite. A negative TLS test confirms an untrusted upstream certificate is still rejected before any request reaches that origin.

## Before release

1. Maintain the reviewed [dependency compatibility build](DEPENDENCY_PATCH.md) until an upstream release supports the fixed versions. Do not replace its declared requirements with bypass flags or silently reintroduce the old caps.
2. Re-run candidate audits and tests after any dependency or source changes.
3. Create the chosen repository using the applicable identity/signing rules, then establish a source revision, license/ownership decision, and security reporting contact.
4. Qualify the actual signed/notarized app/installer and claimed real-device flows using [the release checklist](RELEASE.md). This pass built the UI and frozen engine, not a signed 1.0.0 installer. Intel, minimum-runtime, MDM and real-device matrix checks remain unrun.

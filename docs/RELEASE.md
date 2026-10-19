# Release qualification

This checklist records what was actually verified for a specific Streamglass artifact. A passing source suite, frozen engine, local installer, signed distribution, and device test are different claims. Keep the release record beside the artifact; do not infer an unchecked result from another gate.

## Prepare the candidate

The identified dependency advisories are resolved by the reviewed [compatibility build](DEPENDENCY_PATCH.md) for Apple Silicon. Rerun both audits for the actual candidate and record new advisories or lookup failures before choosing the 1.0.0 version. Signing, notarization and claimed device-platform checks remain separate gates.

1. Confirm `package.json` and `package-lock.json` have the intended same version and dependency set. Review release notes and update the [README](../README.md), [security guide](../SECURITY.md), [device guide](DEVICES.md), and [roadmap](ROADMAP.md) where the candidate changes behavior.
2. Review the source tree for generated profiles, captures, keys, credentials, and machine-specific paths. Use synthetic fixtures in the repository. The packaged app should include only the intended app assets and frozen engine.
3. Record the source revision or source archive identifier, macOS version, CPU architecture, Node and Python versions used to build, and exact command. Keep unsigned local output separate from signed distribution output.

## Verify the candidate

Run checks only when authorized for the release task. The [test matrix](DEVELOPMENT.md#test-matrix) explains their scope.

| Gate | Suggested command or exercise | Record |
| --- | --- | --- |
| Frontend contract | `npm run typecheck` | Pass/fail and compiler version |
| Dependency advisories | `npm run audit:js` and `npm run audit:python` | Database date, active advisories, lookup failures and disposition |
| JavaScript services and helpers | `npm run test:shell` | Counts and any environment-blocked cases |
| Engine/API behavior | `npm run test:engine` | Counts and any environment-blocked cases |
| Desktop integration | `npm run build:ui`, then `npm run test:desktop` | Source or packaged executable under test |
| Frozen engine | `npm run build:engine`, then `npm run test:frozen-engine` | Isolated startup, authenticated API, gzip forwarding, bounded preview and SSE capture |
| Local package | `npm run build:release` | `.app`, DMG, ZIP paths and launch result |
| Signed distribution, if applicable | `npm run build:release -- --signed` | Signature, notarization, and install/open result |

For a package-level desktop run, set `STREAMGLASS_TEST_APP` to the built app's `Contents/MacOS/Streamglass` executable. Do not reuse a live application profile for verification. A local build is unsigned unless the signed release path was requested and independently checked.

Use controlled clients and endpoints for these manual checks on each intended target:

- Start and stop the proxy. Confirm an HTTP request forwards and appears in the table.
- Enable trust and allowlist for one HTTPS test host. Confirm inspected content on a new connection, and confirm other domains still show only encrypted destination metadata.
- Send a gradual SSE stream with split frames and a terminal event. Confirm events appear before the connection ends and forwarding continues when retention limits are reached.
- Pause capture and rules during a waiting breakpoint and during a stream. Confirm traffic continues with unsent edits bypassed, then resume new traffic. Confirm Stop Proxy interrupts traffic.
- Save and reopen a capture archive, export/import a synthetic `.sgsession`, and verify incomplete-body warnings remain visible.
- Exercise the local MCP client against the packaged app with its dedicated token, including one read and one bounded mutation, if MCP is part of the candidate scope.
- On a target Mac, verify proxy restoration after normal exit and failed setup. Test simulator, Android, and physical iOS only when those paths are claimed for the release.

## Release record

Record each result as **passed**, **failed**, **blocked**, or **not run**, with the target and evidence. Include known limitations such as certificate pinning, managed-Mac permissions, Intel builds, and untested physical devices. Keep captured traffic and credentials out of public release notes. Do not label unsigned or unnotarized artifacts as ready for signed distribution.

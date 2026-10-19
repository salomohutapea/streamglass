# Development

## Prerequisites

Use macOS with Node.js 22.12 or newer and Python 3.12 or newer. Source development needs both runtimes; the packaged app bundles its engine and does not require them. Xcode simulator tools and Android `adb` are needed only for their respective device helpers.

From the repository root:

```sh
npm run dev
```

The launcher installs missing Node dependencies, prepares `.venv`, installs Python project dependencies when needed, starts Vite and the engine, and opens Electron. `npm install` can also be run explicitly; use `npm ci` when you want a clean install from `package-lock.json`. `npm run setup` prepares dependencies without opening the app.

A normal development profile uses `.streamglass-dev` in the checkout. Vite listens on `127.0.0.1:5173`, the proxy defaults to `127.0.0.1:18080`, and MCP uses `127.0.0.1:48723`. The engine management port is allocated at launch. Existing profile settings can override the proxy default. These defaults let development run alongside the packaged app; configure a client with the address shown in the running app.

| Variable | Purpose |
| --- | --- |
| `STREAMGLASS_DATA_DIR` | Select a separate application-data profile |
| `STREAMGLASS_PROXY_PORT` | Set the default proxy port for a new profile |
| `STREAMGLASS_MCP_PORT` | Set the local MCP listener port |
| `STREAMGLASS_PYTHON` | Use a preconfigured Python executable; setup does not modify that environment |

Profiles hold captures, credentials, certificate material, and saved network settings. Keep development profiles out of source control. To discard a profile, first restore any proxy changes through the app and close it; deleting the files alone does not restore system settings.

## Repository map

- `frontend/src/`: React traffic inspector, detached editors, JSON viewers, device setup, and MCP settings.
- `electron/`: Desktop lifecycle, menus, IPC, network/device helpers, application resolution, exports, scripting, and MCP.
- `backend/`: Python management API, mitmproxy integration, rules, pending gates, captures, SSE, and large-body handling.
- `backend/tests/`, `tests/`, and colocated `*.test.mjs`: Backend, JavaScript, and desktop checks.
- `scripts/`: Development setup, engine freezing, icons, and release packaging.
- `docs/`: User workflows, device configuration, MCP, architecture, and this guide.

Read [architecture](ARCHITECTURE.md) before changing contracts across these layers. The current engine dependencies are `mitmproxy==12.2.3+streamglass.1` and `aiohttp==3.14.5` in `pyproject.toml`. Setup first prepares the checksum-verified [compatibility wheel](DEPENDENCY_PATCH.md), applies `constraints-macos.txt`, and invalidates its Python dependency stamp when the recipe or pins change. The async SSE extension checks the pinned mitmproxy implementation at startup; dependency changes require compatibility review and integration testing. Run `npm run audit:js` and `npm run audit:python` separately to assess both ecosystems; see [security findings and resolution](SECURITY_REVIEW.md).

## Continuous integration and releases

GitHub Actions workflows live in `.github/workflows/` and run on macOS (Apple Silicon) runners:

- **CI** (`ci.yml`) runs on every pull request and every push to `main`: typecheck, shell tests, engine tests, UI build, and desktop tests. Require the `Test` check in branch protection.
- **Bump version** (`bump-version.yml`) is started manually from the Actions tab (patch, minor, major, or an exact `x.y.z`). It runs `npm run bump`, which updates `package.json`, the lockfile root, and `pyproject.toml`, then opens a pull request. With the default workflow token, GitHub holds that PR's CI run until someone clicks "Approve and run workflows" on the PR; add a `BUMP_PR_TOKEN` repository secret (a personal access token with `repo` scope) to skip the approval. You can also run `npm run bump -- patch` locally.
- **Release** (`release.yml`) runs when `package.json` changes on `main`. If the version differs from the previous commit and the `vX.Y.Z` tag does not exist, it builds an unsigned macOS release and publishes the DMG, ZIP, and `SHA256SUMS.txt` on the GitHub Releases page. It can also be started manually to publish the current version when its tag is missing.

**Update notifications.** Packaged builds check the latest GitHub release at launch and every six hours, and show a banner when a newer version exists; "View release" opens the release page in the browser. This is a notification, not an automatic install: Electron's `autoUpdater` (Squirrel.Mac) only installs updates signed with the same Apple Developer ID, which unsigned builds do not have. Once releases are signed and notarized, replace the notifier in `electron/updater.mjs` with `autoUpdater` or `electron-updater`. Set `STREAMGLASS_DISABLE_UPDATE_CHECK=1` to turn the check off; development runs never check.

The release build is unsigned and not notarized; see the Local releases section for what users see on first launch.

## Local releases

```sh
npm run build:release
```

The release command prepares dependencies, builds the UI and frozen engine, then packages a macOS `.app`, DMG, and ZIP for the current machine architecture. Each run writes to a new versioned, timestamped directory under `release/local/` and refuses to overwrite an existing destination. After a successful build, older timestamped build folders there are deleted so only the newest remains; pass `--keepPreviousBuilds` (`npm run build:release -- --keepPreviousBuilds`) to keep them. A failed build removes nothing. `npm run package:mac` is an alias for the same workflow.

The default produces a local build without distribution signing or notarization. macOS may require explicit approval to open an externally distributed build. The command does not establish release qualification for other architectures or machines.

For a distribution build with configured Apple signing and notarization credentials:

```sh
npm run build:release -- --signed
```

Keep credentials outside the repository. Check the resulting signing/notarization status before distributing. Do not describe a default local build as signed for distribution or notarized.

The app logo source is `frontend/src/assets/streamglass.svg`; prebuilt Electron and macOS icons are included under `electron/assets/`. `npm run build:icons` regenerates them on macOS using installed Chrome and `iconutil`. Ordinary app users do not need those tools.

## Verification commands

Run only the checks appropriate to the change and authorized for the task. These commands are documented here; reading or updating documentation does not require running them.

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Frontend TypeScript contracts |
| `npm run test:shell` | JavaScript helpers, scripts, MCP, applications, exports, and viewer behavior |
| `npm run test:engine` | Python engine and API tests |
| `npm run build:ui` | Production renderer assets |
| `npm run test:desktop` | Electron integration; requires built UI assets |
| `npm run build:engine` | Frozen Python engine |

For a desktop check against a packaged app, set `STREAMGLASS_TEST_APP` to that app's `Contents/MacOS/Streamglass` executable. Source checks and frozen-engine checks establish different things; report which target was used. Device certificate trust, proxy restoration, managed-device permissions, and application pinning need target-specific verification.

### Test matrix

| Change or claim | Relevant checks | What remains separate |
| --- | --- | --- |
| React types and renderer behavior | `npm run typecheck`; focused colocated JavaScript tests, then `npm run test:shell` for affected helpers | A type check does not exercise Electron windows or proxy traffic |
| Engine validation, capture, rules, body previews, or SSE | Focused `backend/tests/` case, then `npm run test:engine` | Unit tests alone do not prove device routing or long-lived stream behavior |
| Electron bridge, MCP, exports, or scripts | Focused `tests/*.test.mjs`, then `npm run test:shell` | Listener tests need permission to bind local loopback addresses |
| Main window and Tools interactions | `npm run build:ui` followed by `npm run test:desktop` | Desktop tests exercise the local app, not a signed installer or physical device |
| Frozen engine or release packaging | `npm run build:engine`; `npm run build:release` when release qualification is requested | Source-engine results do not prove the frozen binary; local packaging does not prove signing or notarization |
| Mac, simulator, Android, physical iOS, TLS trust | Targeted manual checks using [device setup](DEVICES.md) | Report each tested OS/device/architecture separately; proxy and trust policies vary |

Use synthetic endpoints and data. A socket-bind failure in a restricted test environment is an environment limit; record the failing command and error rather than counting the blocked cases as passes. Likewise, distinguish tests that completed from those not run.

When changing compressed response handling, include cases whose decompressed size exceeds retention even when the wire body is small. Check that the capture reports an incomplete preview and that forwarding bytes remain unchanged; `backend/tests/test_body_preview.py` covers bounded decoding primitives.

### Local release review

Before labeling a 1.0.0 artifact, use the [release qualification checklist](RELEASE.md). It separates source checks, package checks, distribution signing, and target-device exercises, and records which were actually completed.

## Troubleshooting

**Startup dependency failure:** read the launcher's first error, verify the Node/Python versions, and rerun `npm run setup`. If using `STREAMGLASS_PYTHON`, install project dependencies into that environment yourself.

**Port in use:** close the conflicting development server or set a separate proxy/MCP port. Vite expects its configured loopback port. Do not expose the engine management interface to solve a device connection issue; enable LAN proxy access in the app instead.

**No HTTPS bodies:** verify the client uses the proxy, trusts the public certificate, and the target domain is allowlisted. Reconnect the client after enabling inspection. Pinning or organization policies can prevent interception.

**Mac proxy helper denied:** follow the managed-Mac guidance in [device setup](DEVICES.md). Certificate-only simulator setup does not change network proxy settings; ask IT to configure those when policy requires it.

**Connection problems after exit:** restore saved proxy settings using the app, or inspect the affected platform's proxy configuration. A deleted capture or data directory cannot restore a network setting.

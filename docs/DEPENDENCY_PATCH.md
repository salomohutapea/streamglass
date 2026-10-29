# mitmproxy compatibility build

Streamglass maintains `mitmproxy==12.2.3+streamglass.2` because upstream 12.2.3 still restricts dependencies to releases with known advisories. This is a Streamglass-maintained compatibility build, **not an upstream-supported dependency combination**. It changes wheel metadata only; the 285 upstream non-metadata files and the MIT license are preserved byte-for-byte.

## Exact changes

| Package | Old installed version | Compatibility build requirement |
| --- | --- | --- |
| Brotli | 1.2.0 | 1.2.1, fixes CVE-2026-111497 |
| cryptography | 48.0.1 | 50.0.2 |
| h2 | 4.3.0 | 4.4.1 |
| msgpack | 1.1.2 | 1.2.3 |
| tornado | 6.5.5 | 6.6 |
| pyOpenSSL | 26.2.0 | 26.4.0, compatible with cryptography 50 |

The package version is the seventh metadata change. Build `+streamglass.2` added the Brotli requirement and moved tornado from 6.5.10 to 6.6; `+streamglass.1` is superseded. The `.dist-info` directory is renamed and all wheel RECORD digests are regenerated. No upstream Python source, license, signatures, or security checks are removed. We do not use `--no-deps`, edit installed dependency metadata, suppress advisories, or mark known advisories as ignored.

## Reproduction and provenance

`scripts/prepare_mitmproxy.py` fetches this exact [upstream wheel](https://files.pythonhosted.org/packages/e0/56/0df365a56624472c397b45788b64a5c10ecabf0de3858bf538b42875a268/mitmproxy-12.2.3-py3-none-any.whl), checks its SHA-256 before opening it, and rejects unexpected metadata. The expected upstream SHA-256 is:

```text
df75ccd15ccb39ab55ce9dd4130312270e8ba208eb927a7cbe50cb52678ec722
```

The recipe writes the wheel to ignored `build/wheels/`. Cached upstream bytes are checked again on every run. Archive timestamps and ordering are fixed; repeated builds using the same Python/zlib runtime produce identical bytes. The upstream digest, exact metadata assertions, and preserved source bytes are the cross-toolchain provenance checks.

`npm run setup`, `npm run dev`, and `npm run build:release` prepare this wheel automatically. Manual setup from the repository root:

```sh
python3 -m venv .venv
.venv/bin/python scripts/prepare_mitmproxy.py
.venv/bin/python -m pip install --find-links build/wheels -c constraints-macos.txt -e '.[package]'
.venv/bin/python -m pip check
npm run audit:python
```

The local version is required in `pyproject.toml`, the constraints, and the engine startup guard. Setup's cache key includes the recipe. A plain install that cannot find this wheel fails instead of silently substituting the vulnerable public dependency set. For a custom `STREAMGLASS_PYTHON`, perform the manual setup with that interpreter first.

The OSV checker strips local version suffixes when querying public advisories and reports both installed and audited versions. Thus this mitmproxy package is audited as upstream `12.2.3`; labeling it as a local build does not hide upstream findings.

## Compatibility and maintenance

The real proxy tests cover TLS CONNECT and negotiated HTTP/2, ordinary responses, SSE delivery before upstream completion, reset isolation, and rejecting duplicate Host headers before they reach the origin. Existing suites cover synthetic CA creation, inspected HTTPS, codecs, request/response/event edits, pause behavior and large compressed bodies. Wheel tests verify unchanged code/license, deterministic output, valid RECORD digests, checksum rejection, and metadata-change rejection. Audit tests verify the public-version mapping.

Verification on 2026-10-18: 152 Python tests, 110 JavaScript tests, five desktop tests, TypeScript, `pip check`, clean-environment dependency resolution and `npm run setup` passed. The rebuilt frozen engine passed authenticated startup, unchanged gzip forwarding, bounded decoded inspection and SSE capture. A negative TLS case verifies untrusted upstream certificates remain rejected. OSV reported zero active findings across 58 installed distributions. These results apply to this exact dependency set and the tested Apple Silicon environment.

This dependency set is qualified on **macOS Apple Silicon**. Cryptography 49 removed Intel macOS wheels; do not advertise an Intel build using this recipe. See the [cryptography changelog](https://cryptography.io/en/latest/changelog/), [pyOpenSSL changelog](https://www.pyopenssl.org/en/latest/changelog.html), and [h2 release notes](https://python-hyper.org/projects/hyper-h2/en/stable/release-notes.html).

When an upstream mitmproxy release supports the fixed versions: compare its source, update the engine extension deliberately, remove the recipe and local label together, refresh constraints, and rerun the full suite, advisory scan and frozen-engine smoke check. Until then, Streamglass owns testing and maintenance of this combination. Zero advisory matches do not guarantee the absence of undiscovered vulnerabilities or replace signing, notarization and real-device qualification.

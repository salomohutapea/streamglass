"""Build the reproducible metadata-only Streamglass compatibility wheel."""
import base64
import csv
import hashlib
import io
from pathlib import Path
import tempfile
import urllib.request
import zipfile

UPSTREAM_VERSION = "12.2.3"
VERSION = "12.2.3+streamglass.2"
URL = "https://files.pythonhosted.org/packages/e0/56/0df365a56624472c397b45788b64a5c10ecabf0de3858bf538b42875a268/mitmproxy-12.2.3-py3-none-any.whl"
SHA256 = "df75ccd15ccb39ab55ce9dd4130312270e8ba208eb927a7cbe50cb52678ec722"
REPLACEMENTS = {
    "Version: 12.2.3": f"Version: {VERSION}",
    "Requires-Dist: Brotli<=1.2.0,>=1.0": "Requires-Dist: Brotli==1.2.1",
    "Requires-Dist: cryptography<=48.1,>=42.0": "Requires-Dist: cryptography==50.0.2",
    "Requires-Dist: h2<=4.3.0,>=4.3.0": "Requires-Dist: h2==4.4.1",
    "Requires-Dist: msgpack<=1.1.2,>=1.0.0": "Requires-Dist: msgpack==1.2.3",
    "Requires-Dist: tornado<=6.5.5,>=6.5.0": "Requires-Dist: tornado==6.6",
    "Requires-Dist: pyOpenSSL<=27.0.0,>=24.3": "Requires-Dist: pyOpenSSL==26.4.0",
}


def rebuild(upstream):
    if hashlib.sha256(upstream).hexdigest() != SHA256:
        raise ValueError("Upstream wheel checksum mismatch")
    old, new = f"mitmproxy-{UPSTREAM_VERSION}.dist-info/", f"mitmproxy-{VERSION}.dist-info/"
    with zipfile.ZipFile(io.BytesIO(upstream)) as wheel:
        if sum(item.file_size for item in wheel.infolist()) > 64 * 1024 * 1024:
            raise ValueError("Unexpected upstream wheel size")
        files = {name.replace(old, new, 1) if name.startswith(old) else name: wheel.read(name)
                 for name in wheel.namelist() if name != old + "RECORD"}
    metadata = files[new + "METADATA"].decode()
    lines = metadata.splitlines(keepends=True)
    for before, after in REPLACEMENTS.items():
        matches = [index for index, line in enumerate(lines) if line.rstrip("\r\n") == before]
        if len(matches) != 1:
            raise ValueError(f"Unexpected upstream metadata: {before}")
        index = matches[0]
        lines[index] = after + "\n"
    files[new + "METADATA"] = "".join(lines).encode()
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, contents in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(contents).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + digest, len(contents)))
    writer.writerow((new + "RECORD", "", ""))
    files[new + "RECORD"] = record.getvalue().encode()
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as wheel:
        for name, contents in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            wheel.writestr(info, contents)
    return result.getvalue()


def prepare():
    folder = Path(__file__).resolve().parent.parent / "build" / "wheels"
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / f"mitmproxy-{UPSTREAM_VERSION}.upstream.whl"
    if source.exists():
        upstream = source.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            upstream = response.read(4 * 1024 * 1024 + 1)
        if hashlib.sha256(upstream).hexdigest() != SHA256:
            raise ValueError("Downloaded upstream wheel checksum mismatch")
        source.write_bytes(upstream)
    result = rebuild(upstream)
    destination = folder / f"mitmproxy-{VERSION}-py3-none-any.whl"
    with tempfile.NamedTemporaryFile(dir=folder, delete=False) as temporary:
        temporary.write(result)
        staging = Path(temporary.name)
    try:
        staging.replace(destination)
    finally:
        staging.unlink(missing_ok=True)
    print(f"Prepared {destination.name}; sha256={hashlib.sha256(result).hexdigest()}")


if __name__ == "__main__":
    prepare()

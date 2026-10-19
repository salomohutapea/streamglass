"""Query OSV using installed public package names/versions only (no source or captures)."""
import concurrent.futures
import importlib.metadata
import json
import sys
import urllib.request
from datetime import datetime, timezone


def fetch(path, payload=None):
    request = urllib.request.Request("https://api.osv.dev/v1/" + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "Streamglass-dependency-audit"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def main():
    packages = sorted((d.metadata["Name"], d.version) for d in importlib.metadata.distributions()
                      if d.metadata["Name"].lower() != "streamglass-backend")
    # A local compatibility label must not hide vulnerabilities in upstream code.
    queries = [{"package": {"name": name, "ecosystem": "PyPI"}, "version": version.split("+", 1)[0]} for name, version in packages]
    matches = fetch("querybatch", {"queries": queries})["results"]
    ids = sorted({v["id"] for match in matches for v in match.get("vulns", [])})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        details = dict(zip(ids, pool.map(lambda identifier: fetch("vulns/" + identifier), ids)))
    findings = []
    for (name, version), match in zip(packages, matches):
        advisories = []
        for hit in match.get("vulns", []):
            detail = details[hit["id"]]
            if detail.get("withdrawn"):
                continue
            advisories.append({"id": detail["id"], "aliases": detail.get("aliases", []),
                "summary": detail.get("summary", ""), "modified": detail.get("modified"),
                "fixed": sorted({event["fixed"] for affected in detail.get("affected", [])
                    if affected["package"]["name"].lower() == name.lower()
                    for span in affected.get("ranges", []) for event in span.get("events", []) if "fixed" in event}),
                "url": "https://osv.dev/vulnerability/" + detail["id"]})
        if advisories:
            findings.append({"package": name, "version": version, "advisories": advisories})
    print(json.dumps({"checkedAt": datetime.now(timezone.utc).isoformat(), "source": "OSV",
        "packagesChecked": len(packages), "localVersions": [{"package": name, "installed": version,
            "auditedUpstream": version.split("+", 1)[0]} for name, version in packages if "+" in version],
        "findings": findings}, indent=2))
    return 1 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": "Advisory lookup failed; dependencies are not assessed."}))
        sys.exit(2)

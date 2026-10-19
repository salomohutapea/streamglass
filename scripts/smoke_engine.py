"""Synthetic smoke check for a frozen engine; never uses a real profile or system proxy."""
import gzip
import http.client
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def free_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def main():
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else "engine-dist/streamglass-engine/streamglass-engine").resolve()
    token = secrets.token_hex(32)
    expanded = b"synthetic-response\n" * 500000
    compressed = gzip.compress(expanded)
    events = b"event: context\ndata: {}\n\nevent: data\ndata: done\n\n"

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            stream = self.path == "/sse"
            value = events if stream else compressed
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if stream else "text/plain")
            if not stream:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)

    fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="streamglass-frozen-smoke-") as directory:
            management, proxy = free_port(), free_port()
            while proxy == management:
                proxy = free_port()
            with sqlite3.connect(Path(directory) / "captures.sqlite3") as db:
                db.execute("CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
                db.execute("INSERT INTO config VALUES (?,?)", ("settings", json.dumps({"proxyPort": proxy})))
            environment = {key: value for key, value in os.environ.items() if not key.startswith("STREAMGLASS_")}
            environment["STREAMGLASS_TOKEN"] = token
            process = subprocess.Popen([str(binary), "--port", str(management), "--data-dir", directory],
                env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                def api(path):
                    connection = http.client.HTTPConnection("127.0.0.1", management, timeout=2)
                    try:
                        connection.request("GET", path, headers={"Authorization": "Bearer " + token})
                        response = connection.getresponse()
                        assert response.status == 200, response.status
                        return json.loads(response.read())
                    finally:
                        connection.close()
                for attempt in range(600):
                    if process.poll() is not None:
                        raise RuntimeError("Frozen engine exited during startup")
                    try:
                        api("/api/state")
                        break
                    except (OSError, http.client.HTTPException):
                        time.sleep(.1)
                else:
                    raise RuntimeError("Frozen engine did not become ready")
                for endpoint, expected in (("/large", compressed), ("/sse", events)):
                    connection = http.client.HTTPConnection("127.0.0.1", proxy, timeout=10)
                    try:
                        connection.request("GET", f"http://127.0.0.1:{fixture.server_port}{endpoint}")
                        response = connection.getresponse()
                        assert response.status == 200
                        assert response.read() == expected, "Proxy changed forwarded bytes"
                    finally:
                        connection.close()
                records = api("/api/state")["records"]
                assert len(records) == 2
                large = next(record for record in records if record["url"].endswith("/large"))
                detail = api("/api/records/" + large["id"])
                assert detail["response"]["bodyUnavailable"]
                sse = next(record for record in records if record["url"].endswith("/sse"))
                assert sse["eventCount"] == 2
                print("Frozen engine: startup, authenticated API, unchanged gzip forwarding, bounded preview and SSE capture passed.")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                diagnostic = process.stderr.read().decode("utf-8", "replace")
                process.stderr.close()
                if sys.exc_info()[0] is not None and diagnostic:
                    print(diagnostic[-4000:], file=sys.stderr)
    finally:
        fixture.shutdown()
        fixture.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()

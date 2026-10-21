import unittest

from backend.sse_status import classify_end, finish, sse_status


def stream(**values):
    return {"state": "streaming", "isSSE": True, "eventCount": 0, "sseDiagnostics": {"headersAt": None, "firstEventAt": None, "endReason": None}, **values}


class SseStatusTests(unittest.TestCase):
    def test_live_phases(self):
        record = stream(state="pending")
        self.assertEqual(sse_status(record), "connecting")
        record.update(state="streaming")
        record["sseDiagnostics"]["headersAt"] = 1.0
        self.assertEqual(sse_status(record), "open")
        record["sseDiagnostics"]["firstEventAt"] = 1.5
        self.assertEqual(sse_status(record), "streaming")

    def test_end_reasons_from_mitmproxy_messages(self):
        self.assertEqual(classify_end("Client disconnected."), "client-closed")
        self.assertEqual(classify_end("stream reset by client (CANCEL)"), "client-closed")
        self.assertEqual(classify_end("stream reset by client (INTERNAL_ERROR)"), "stream-reset")
        self.assertEqual(classify_end("server closed connection"), "server-dropped")
        self.assertEqual(classify_end("peer closed connection"), "server-dropped")
        self.assertEqual(classify_end("Connection killed."), "proxy-closed")
        self.assertEqual(classify_end("upstream-eof"), "server-closed")
        self.assertEqual(classify_end("TLS alert"), "error")

    def test_finish_records_reason_detail_and_time_once(self):
        record = stream(state="error", error="Client disconnected.", endedAt=5.0)
        finish(record)
        self.assertEqual(record["sseDiagnostics"], {"headersAt": None, "firstEventAt": None, "endReason": "client-closed", "endDetail": "Client disconnected.", "endedAt": 5.0})
        record["error"] = "Connection killed."
        finish(record)
        self.assertEqual(record["sseDiagnostics"]["endReason"], "client-closed")
        self.assertEqual(sse_status(record), "client-closed")

    def test_clean_end_and_proxy_kill(self):
        record = stream(state="complete", endedAt=2.0)
        finish(record)
        self.assertEqual(sse_status(record), "server-closed")
        killed = stream(state="error", error="Connection closed by Block rule x", endedAt=3.0)
        killed["sseDiagnostics"]["endReason"] = "proxy-closed"
        finish(killed)
        self.assertEqual((killed["sseDiagnostics"]["endReason"], killed["sseDiagnostics"]["endDetail"]), ("proxy-closed", "Connection closed by Block rule x"))

    def test_legacy_raw_end_reason(self):
        record = stream(state="error", error="Client disconnected.")
        record["sseDiagnostics"]["endReason"] = "Client disconnected."
        self.assertEqual(sse_status(record), "client-closed")
        record = stream(state="complete")
        record["sseDiagnostics"]["endReason"] = "upstream-eof"
        self.assertEqual(sse_status(record), "server-closed")


if __name__ == "__main__":
    unittest.main()

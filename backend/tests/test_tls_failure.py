import tempfile
import unittest
from types import SimpleNamespace
from backend.service import Service


def hook_data(client_id, error, peer="10.0.0.5", host="api.example.test"):
    client = SimpleNamespace(id=client_id, peername=(peer, 5555), sni=host)
    server = SimpleNamespace(address=(host, 443))
    return SimpleNamespace(conn=SimpleNamespace(error=error), context=SimpleNamespace(client=client, server=server))


class TlsFailureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.service = Service(self.directory.name, 'tls-token', 47821)

    def test_creates_record_for_untrusted_ca(self):
        self.service.tls_failed_client(hook_data("c1", "tlsv1 alert unknown ca"))
        (record,) = self.service.records.values()
        self.assertEqual(record["host"], "api.example.test")
        self.assertEqual(record["state"], "error")
        self.assertEqual(record["tlsFailure"]["side"], "client")
        self.assertEqual(record["tlsFailure"]["likelyCause"], "untrusted-ca")
        self.assertIn("tlsFailure", self.service.state()["records"][0])

    def test_attaches_to_existing_tunnel(self):
        self.service.save({"id": "t1", "kind": "tunnel", "host": "api.example.test", "port": 443, "url": "api.example.test:443",
                           "startedAt": 1.0, "state": "pending", "events": []})
        self.service.tunnels["c2"] = "t1"
        self.service.tls_failed_client(hook_data("c2", "Client disconnected during the handshake."))
        self.assertEqual(len(self.service.records), 1)
        self.assertEqual(self.service.records["t1"]["tlsFailure"]["likelyCause"], "pinning")

    def test_repeated_failure_on_working_device_is_pinning(self):
        self.service.tls_established_client(hook_data("ok", None))
        self.service.tls_failed_client(hook_data("c3", "tlsv1 alert unknown ca"))
        self.service.tls_failed_client(hook_data("c4", "tlsv1 alert unknown ca"))
        causes = sorted(r["tlsFailure"]["likelyCause"] for r in self.service.records.values())
        self.assertEqual(causes, ["pinning", "untrusted-ca"])

    def test_server_side_failure_and_protocol(self):
        self.service.tls_failed_server(hook_data("c5", "The remote server does not speak TLS."))
        (record,) = self.service.records.values()
        self.assertEqual(record["tlsFailure"]["side"], "server")
        self.assertEqual(record["tlsFailure"]["likelyCause"], "protocol")

    def test_paused_capture_records_nothing(self):
        self.service.settings["capturePaused"] = True
        self.service.tls_failed_client(hook_data("c6", "x"))
        self.assertFalse(self.service.records)

    def test_close_after_handshake_without_request_is_flagged(self):
        self.service.save({"id": "t2", "kind": "tunnel", "host": "api.example.test", "port": 443, "url": "api.example.test:443",
                           "startedAt": 1.0, "state": "connected", "events": []})
        self.service.tunnels["c7"] = "t2"
        data = hook_data("c7", None)
        self.service.tls_established_client(data)
        self.service.client_disconnected(data.context.client)
        record = self.service.records["t2"]
        self.assertEqual(record["state"], "complete")
        self.assertEqual(record["tlsFailure"]["likelyCause"], "closed-after-handshake")

    def test_close_without_tls_is_not_flagged(self):
        self.service.save({"id": "t3", "kind": "tunnel", "host": "other.example.test", "port": 443, "url": "other.example.test:443",
                           "startedAt": 1.0, "state": "connected", "events": []})
        self.service.tunnels["c8"] = "t3"
        self.service.client_disconnected(hook_data("c8", None).context.client)
        self.assertNotIn("tlsFailure", self.service.records["t3"])


if __name__ == "__main__":
    unittest.main()

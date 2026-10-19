import tempfile
import unittest
from unittest.mock import patch

from backend.service import Service


def record(index, host, **extra):
    return {"id": f"r{index}", "kind": "request", "method": "GET", "url": f"https://{host}/item/{index}", "startedAt": float(index), "state": "complete", **extra}


class RetentionTests(unittest.TestCase):
    def service(self, directory, domains):
        service = Service(directory, "a" * 32, 47821)
        service.settings["tlsDomains"] = domains
        return service

    def test_allowlisted_domains_are_exempt_from_eviction(self):
        with tempfile.TemporaryDirectory() as directory, patch("backend.service.MAX_RECORDS", 2):
            service = self.service(directory, ["api.example.test", "*.corp.example.test"])
            for index in range(1, 9):
                host = {0: "api.example.test", 1: "other.example.test", 2: "a.corp.example.test"}[index % 3]
                service.save(record(index, host))
            hosts = {r["url"].split("/")[2] for r in service.records.values()}
            allowlisted = [r for r in service.records.values() if r["url"].split("/")[2] != "other.example.test"]
            others = [r for r in service.records.values() if r["url"].split("/")[2] == "other.example.test"]
            self.assertEqual(len(allowlisted), 5)
            self.assertEqual(hosts, {"api.example.test", "a.corp.example.test", "other.example.test"})
            self.assertEqual(sorted(r["id"] for r in others), ["r4", "r7"])
            self.assertEqual(len(service.records), 7)

    def test_other_domains_are_still_capped_oldest_first(self):
        with tempfile.TemporaryDirectory() as directory, patch("backend.service.MAX_RECORDS", 3):
            service = self.service(directory, ["api.example.test"])
            service.save(record(0, "api.example.test"))
            for index in range(1, 7):
                service.save(record(index, "other.example.test"))
            self.assertEqual(sorted(service.records), ["r0", "r4", "r5", "r6"])

    def test_inspected_records_are_kept_even_after_the_domain_leaves_the_allowlist(self):
        with tempfile.TemporaryDirectory() as directory, patch("backend.service.MAX_RECORDS", 1):
            service = self.service(directory, [])
            service.save(record(1, "old.example.test", sslInspected=True))
            for index in range(2, 5):
                service.save(record(index, "other.example.test"))
            self.assertIn("r1", service.records)
            self.assertEqual(sorted(service.records), ["r1", "r4"])

    def test_discard_captures_empties_memory_and_database_but_keeps_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.service(directory, ["api.example.test"])
            service.persist_config(rules=[], folders=[], codecs=[], traffic_tools=service.traffic_tools)
            service.save(record(1, "api.example.test", pinned=True))
            service.discard_captures()
            self.assertEqual(service.records, {})
            service.db.close()
            reopened = Service(directory, "a" * 32, 47821)
            self.assertEqual(reopened.records, {})
            self.assertEqual(reopened.settings["tlsDomains"], ["api.example.test"])
            reopened.db.close()


if __name__ == "__main__":
    unittest.main()

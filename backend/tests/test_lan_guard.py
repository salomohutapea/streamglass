"""LAN device approval and destination guard, with synthetic connection objects and an isolated profile."""
import asyncio
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from backend.api import create_app
from backend.lan_guard import is_lan_client, restricted, validate_destinations, validate_devices, _address
from backend.service import Service


def client(address, port=50000):
    return SimpleNamespace(id=f"client-{address}", peername=(address, port), error=None)


def connection(client_address, host, port=443, peer=None):
    return SimpleNamespace(client=client(client_address), server=SimpleNamespace(address=(host, port), peername=peer, error=None))


class LanGuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "synthetic-management-token", 47821)
        self.client = TestClient(TestServer(create_app(self.service)))
        await self.client.start_server()
        self.headers = {"Authorization": "Bearer synthetic-management-token", "Host": "127.0.0.1:47821"}

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    def test_lan_access_is_off_by_default(self):
        self.assertEqual(self.service.settings["listenHost"], "127.0.0.1")
        self.assertEqual(self.service.settings["lanDevices"], [])

    def test_loopback_clients_are_never_restricted(self):
        for address in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            self.assertFalse(is_lan_client(client(address)))
            self.assertTrue(self.service.lan_guard.client_connected(client(address)))
        self.assertTrue(is_lan_client(client("192.168.1.30")))

    async def test_unknown_device_is_refused_until_approved(self):
        phone = client("192.168.1.30")
        self.service.client_connected(phone)
        self.assertTrue(phone.error)
        state = await (await self.client.get("/api/state", headers=self.headers)).json()
        self.assertEqual([(item["address"], item["attempts"], item["denied"]) for item in state["lanRequests"]], [("192.168.1.30", 1, False)])
        response = await self.client.post("/api/lan-devices", headers=self.headers, json={"address": "192.168.1.30", "allow": True})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["lanRequests"], [])
        again = client("192.168.1.30")
        self.assertTrue(self.service.lan_guard.client_connected(again))
        self.assertIsNone(again.error)
        self.service.db.close()
        reopened = Service(self.directory.name, "synthetic-management-token", 47821)
        self.assertEqual(reopened.settings["lanDevices"], ["192.168.1.30"])
        reopened.db.close()

    async def test_denied_device_stays_refused_and_is_not_prompted_again(self):
        self.service.lan_guard.client_connected(client("10.0.0.9"))
        response = await self.client.post("/api/lan-devices", headers=self.headers, json={"address": "10.0.0.9", "allow": False})
        self.assertEqual(response.status, 200)
        retry = client("10.0.0.9")
        self.assertFalse(self.service.lan_guard.client_connected(retry))
        self.assertTrue(retry.error)
        self.assertTrue(self.service.lan_guard.summary()[0]["denied"])

    async def test_device_requests_are_bounded(self):
        for index in range(100):
            self.service.lan_guard.client_connected(client(f"10.1.0.{index}"))
        self.assertEqual(len(self.service.lan_guard.summary()), 32)

    async def test_settings_validate_devices_and_destinations(self):
        for body in ({"lanDevices": ["127.0.0.1"]}, {"lanDevices": ["phone"]}, {"lanAllowedDestinations": ["*"]},
                     {"lanAllowedDestinations": ["0.0.0.0/0"]}, {"lanAllowedDestinations": ["bad host"]}, {"lanAllowedDestinations": "10.0.0.0/8"}):
            response = await self.client.put("/api/settings", headers=self.headers, json=body)
            self.assertEqual(response.status, 400, body)
        response = await self.client.put("/api/settings", headers=self.headers, json={"lanDevices": ["192.168.1.30", "192.168.1.30"], "lanAllowedDestinations": ["Staging.Example.Test", "10.20.1.9/16"]})
        self.assertEqual(response.status, 200)
        value = await response.json()
        self.assertEqual(value["lanDevices"], ["192.168.1.30"])
        self.assertEqual(value["lanAllowedDestinations"], ["staging.example.test", "10.20.0.0/16"])

    async def test_inspected_storage_setting_is_validated_and_applies_immediately(self):
        for value in (255, 4097, "1024", 1024.0, None):
            response = await self.client.put("/api/settings", headers=self.headers, json={"inspectedStorageMiB": value})
            self.assertEqual(response.status, 400, value)
        self.service.settings["tlsDomains"] = ["api.example.test"]
        for index in range(3):
            self.service.save({"id": f"r{index}", "kind": "request", "method": "GET", "url": f"https://api.example.test/{index}",
                               "startedAt": float(index), "state": "complete"})
            # Stand-in for a large retained body, without writing 120 MiB per capture to the test database.
            self.service.record_sizes[f"r{index}"] = 120 * 1024 * 1024
        self.service.retention = None
        self.assertEqual(len(self.service.records), 3)
        response = await self.client.put("/api/settings", headers=self.headers, json={"inspectedStorageMiB": 256})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["inspectedStorageMiB"], 256)
        self.assertEqual(sorted(self.service.records), ["r1", "r2"])

    def test_restricted_addresses(self):
        for value in ("127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "0.0.0.0", "224.0.0.1", "::ffff:10.0.0.1"):
            self.assertTrue(restricted(_address(value)), value)
        for value in ("93.184.216.34", "2606:4700::1111"):
            self.assertFalse(restricted(_address(value)), value)

    async def test_lan_device_cannot_reach_private_or_own_addresses(self):
        guard = self.service.lan_guard
        for host in ("127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.169.254", "[::1]"):
            data = connection("192.168.1.30", host)
            await guard.server_connect(data)
            self.assertIn("blocked a LAN device", data.server.error or "", host)
        public = connection("192.168.1.30", "93.184.216.34")
        await guard.server_connect(public)
        self.assertIsNone(public.server.error)
        local = connection("127.0.0.1", "10.0.0.5")
        await guard.server_connect(local)
        self.assertIsNone(local.server.error)

    async def test_names_are_checked_by_resolved_address(self):
        async def resolve(host, port, **_):
            return [(None, None, None, "", ("10.9.8.7" if host == "internal.example.test" else "93.184.216.34", port))]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", resolve):
            blocked = connection("192.168.1.30", "internal.example.test")
            await self.service.lan_guard.server_connect(blocked)
            self.assertIn("10.9.8.7", blocked.server.error)
            allowed = connection("192.168.1.30", "public.example.test")
            await self.service.lan_guard.server_connect(allowed)
            self.assertIsNone(allowed.server.error)

    async def test_allowed_destinations_are_reachable(self):
        self.service.settings["lanAllowedDestinations"] = validate_destinations(["*.staging.example.test", "10.20.0.0/16"])
        async def resolve(host, port, **_):
            return [(None, None, None, "", ("10.99.0.1", port))]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", resolve):
            for host in ("api.staging.example.test", "10.20.3.4"):
                data = connection("192.168.1.30", host)
                await self.service.lan_guard.server_connect(data)
                self.assertIsNone(data.server.error, host)
        data = connection("192.168.1.30", "10.21.0.1")
        await self.service.lan_guard.server_connect(data)
        self.assertTrue(data.server.error)

    def test_connected_peer_is_checked_again(self):
        # A name that passed server_connect but connected to a private address (DNS rebinding) is refused.
        data = connection("192.168.1.30", "rebind.example.test", peer=("10.0.0.5", 443))
        self.service.lan_guard.server_connected(data)
        self.assertIn("10.0.0.5", data.server.error)
        fine = connection("192.168.1.30", "public.example.test", peer=("93.184.216.34", 443))
        self.service.lan_guard.server_connected(fine)
        self.assertIsNone(fine.server.error)

    def test_validators(self):
        self.assertEqual(validate_devices(["::ffff:192.168.1.2"]), ["192.168.1.2"])
        with self.assertRaises(ValueError):
            validate_devices(["::1"])
        with self.assertRaises(ValueError):
            validate_destinations(["*.*"])


if __name__ == "__main__":
    unittest.main()

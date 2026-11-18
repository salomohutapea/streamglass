"""Synthetic device routing and LAN-to-Mac policy; no device or upstream connections."""
import asyncio
import copy
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mitmproxy import http
from mitmproxy.test.tflow import tflow
from backend.lan_guard import DEV_SERVER_PORTS, _address, is_this_mac
from backend.service import Service


class DeviceRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, "synthetic-token", 47821)
        self.service.lan_guard.decide("192.168.1.30", True)
        self.own = patch("backend.lan_guard.is_this_mac",
                         side_effect=lambda ip: ip.is_loopback or str(ip) == "192.168.1.20")
        self.own.start()
        async def resolve(host, port, **kwargs):
            return [(None, None, None, "", ("127.0.0.1" if host.rstrip(".") == "localhost" else "93.184.216.34", port))]
        self.dns = patch.object(asyncio.get_running_loop(), "getaddrinfo", resolve)
        self.dns.start()

    async def asyncTearDown(self):
        self.dns.stop()
        self.own.stop()
        self.service.db.close()
        self.directory.cleanup()

    def flow(self, host="10.0.2.2", port=8081, peer="127.0.0.1", connect=False):
        flow = tflow()
        flow.client_conn.peername = (peer, 50000)
        flow.request = http.Request.make("GET", f"http://{host}:{port}/status")
        if connect:
            flow.request.method = "CONNECT"
            flow.request.authority = f"{host}:{port}"
        flow.server_conn.address = (host, port)
        return flow

    async def connect(self, flow):
        await self.service.server_connect(SimpleNamespace(client=flow.client_conn, server=flow.server_conn))

    async def test_loopback_alias_http_connect_and_websocket_preserve_request(self):
        for peer in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            for mode in ("http", "connect", "websocket"):
                flow = self.flow(peer=peer, connect=mode == "connect")
                self.service.applications[flow.client_conn.id] = {
                    "task": None, "value": {"deviceKind": "androidEmulator"}, "records": set()}
                if mode == "websocket":
                    flow.request.headers.update({"Connection": "Upgrade", "Upgrade": "websocket"})
                flow.server_conn.sni = "10.0.2.2"
                before = copy.deepcopy(flow.request.data)
                if mode == "connect":
                    self.service.http_connect(flow)
                    self.assertIn("10.0.2.2", self.service.records[flow.id]["url"])
                else:
                    await self.service.requestheaders(flow)
                    await self.service.request(flow)
                    self.assertIn("10.0.2.2", self.service.records[flow.id]["url"])
                await self.connect(flow)
                self.assertIn("Routed to this Mac", self.service.records[flow.id]["annotation"]["note"])
                self.assertEqual(flow.server_conn.address, ("127.0.0.1", 8081))
                self.assertEqual(flow.request.data, before)
                self.assertEqual(flow.server_conn.sni, "10.0.2.2")

    async def test_lan_alias_is_never_rewritten(self):
        flow = self.flow(peer="192.168.1.30")
        await self.connect(flow)
        self.assertEqual(flow.server_conn.address, ("10.0.2.2", 8081))
        self.assertTrue(flow.server_conn.error)

    async def test_unattributed_and_mac_clients_keep_their_original_destination(self):
        for kind in (None, "iosSimulator"):
            flow = self.flow()
            self.service.applications[flow.client_conn.id] = {
                "task": None, "value": {"deviceKind": kind}, "records": set()}
            await self.connect(flow)
            self.assertEqual(flow.server_conn.address, ("10.0.2.2", 8081))

    async def test_mac_dev_server_besides_metro_requires_explicit_destination_approval(self):
        flow = self.flow("127.0.0.1", 5000, "192.168.1.30")
        await self.connect(flow)
        self.assertIn("approve this Mac", flow.server_conn.error)

    async def test_this_mac_dev_ports_allowed_other_ports_denied_even_with_approval(self):
        self.service.settings["lanAllowedDestinations"] = ["localhost", "127.0.0.0/8", "::1", "192.168.1.20"]
        for host in ("localhost", "127.0.0.2", "::1", "::ffff:127.0.0.1", "192.168.1.20"):
            for port in (*DEV_SERVER_PORTS, 22, self.service.port, self.service.settings["proxyPort"]):
                data = SimpleNamespace(client=SimpleNamespace(peername=("192.168.1.30", 50000)),
                                       server=SimpleNamespace(address=(host, port), error=None))
                await self.service.server_connect(data)
                blocked = port not in DEV_SERVER_PORTS or port in (self.service.port, self.service.settings["proxyPort"])
                self.assertEqual(bool(data.server.error), blocked, (host, port))

    async def test_http_and_connect_403_even_while_paused(self):
        self.service.set_capture_paused(True)
        for connect in (False, True):
            for port in (22, self.service.port, self.service.settings["proxyPort"]):
                flow = self.flow("localhost", port, "192.168.1.30", connect)
                if connect:
                    await self.service.http_connect(flow)
                else:
                    await self.service.requestheaders(flow)
                if not connect:
                    await self.service.request(flow)
                self.assertEqual(flow.response.status_code, 403)
                self.assertIn(b"dev-server ports", flow.response.content)
                self.assertTrue(flow.metadata["streamglass_passthrough"])
        self.assertEqual(self.service.records, {})

    async def test_paused_capture_allowed_http_connect_and_websocket_pass_through(self):
        self.service.set_capture_paused(True)
        for peer, host in (("127.0.0.1", "10.0.2.2"), ("192.168.1.30", "localhost")):
            for connect in (False, True):
                flow = self.flow(host, 8081, peer, connect)
                flow.request.headers.update({"Connection": "Upgrade", "Upgrade": "websocket"})
                before = copy.deepcopy(flow.request.data)
                if connect:
                    result = self.service.http_connect(flow)
                    if result is not None:
                        await result
                else:
                    await self.service.requestheaders(flow)
                    await self.service.request(flow)
                await self.connect(flow)
                self.assertIsNone(flow.response)
                self.assertIsNone(flow.server_conn.error)
                self.assertEqual(flow.request.data, before)
        self.assertEqual(self.service.records, {})
        self.assertEqual(self.service.pending, {})

    async def test_local_clients_unrestricted_and_listener_ports_override_allowlist(self):
        self.service.settings["proxyPort"] = 8081
        for peer in ("127.0.0.1", "192.168.1.30"):
            flow = self.flow("localhost", 8081, peer)
            await self.service.requestheaders(flow)
            self.assertEqual(flow.response.status_code if flow.response else None, 403 if peer.startswith("192.") else None)

    async def test_loopback_clients_can_reach_any_local_port(self):
        for port in (22, self.service.port, self.service.settings["proxyPort"]):
            flow = self.flow("localhost", port)
            await self.service.requestheaders(flow)
            await self.connect(flow)
            self.assertIsNone(flow.response)
            self.assertIsNone(flow.server_conn.error)

    def test_rebinding_to_this_mac_is_blocked_even_for_approved_name(self):
        self.service.settings["lanAllowedDestinations"] = ["public.example.test"]
        flow = self.flow("public.example.test", 22, "192.168.1.30")
        flow.server_conn.peername = ("127.0.0.1", 22)
        self.service.server_connected(SimpleNamespace(client=flow.client_conn, server=flow.server_conn))
        self.assertIn("dev-server ports", flow.server_conn.error)

    def test_interface_ownership_probe_binds_without_connecting(self):
        with patch("backend.lan_guard.socket.socket") as socket:
            self.assertTrue(is_this_mac(_address("192.168.1.20")))
            socket.return_value.__enter__.return_value.bind.assert_called_once_with(("192.168.1.20", 0))
            socket.return_value.__enter__.return_value.connect.assert_not_called()
        with patch("backend.lan_guard.socket.socket", side_effect=OSError):
            self.assertFalse(is_this_mac(_address("192.168.1.99")))

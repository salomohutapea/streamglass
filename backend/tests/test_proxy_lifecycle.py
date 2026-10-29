"""Loopback-only listener lifecycle; never touches system proxy settings."""
import asyncio
import socket
import tempfile
import unittest

from aiohttp import ClientSession, ClientTimeout, web

from backend.api import create_app
from backend.service import Service


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ProxyLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="streamglass-lifecycle-")
        self.service = Service(self.directory.name, "lifecycle-only-token-1234567890", free_port())
        self.service.settings["proxyPort"] = free_port()
        self.runner = web.AppRunner(create_app(self.service), access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", self.service.port).start()
        self.client = ClientSession(timeout=ClientTimeout(total=5))
        await self.service.start_proxy()

    async def asyncTearDown(self):
        if self.service.master:
            await self.service.master.addons.get("proxyserver").servers.update([])
            self.service.master.shutdown()
            await self.service.proxy_task
        await self.client.close()
        await self.runner.cleanup()
        self.service.db.close()
        self.directory.cleanup()

    async def settings(self, changes, status=200):
        async with self.client.put(f"http://127.0.0.1:{self.service.port}/api/settings",
                                   headers={"Authorization": "Bearer " + self.service.token},
                                   json=changes) as response:
            self.assertEqual(response.status, status, await response.text())
            return await response.json()

    async def test_stop_releases_listener_and_play_restarts_on_same_port(self):
        port = self.service.settings["proxyPort"]
        for _ in range(2):
            stopped = await self.settings({"proxyEnabled": False, "capturePaused": True})
            self.assertFalse(stopped["proxyRunning"])
            with self.assertRaises(OSError):
                await asyncio.open_connection("127.0.0.1", port)
            resumed = await self.settings({"proxyEnabled": True, "capturePaused": False})
            self.assertTrue(resumed["proxyRunning"])
            self.assertFalse(resumed["capturePaused"])
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
            await writer.wait_closed()

    async def test_occupied_port_restores_previous_listener_without_exiting(self):
        previous_port = self.service.settings["proxyPort"]
        occupied = await asyncio.start_server(lambda reader, writer: writer.close(), "127.0.0.1", 0)
        try:
            port = occupied.sockets[0].getsockname()[1]
            error = await self.settings({"proxyPort": port}, status=400)
            self.assertIn("previous settings restored", error["error"]["message"])
            self.assertEqual(self.service.settings["proxyPort"], previous_port)
            self.assertTrue(self.service.state()["settings"]["proxyRunning"])
            reader, writer = await asyncio.open_connection("127.0.0.1", previous_port)
            writer.close()
            await writer.wait_closed()
        finally:
            occupied.close()
            await occupied.wait_closed()

    async def test_breakpoint_gate_has_no_timeout(self):
        # Gates wait until resolved, released by pause, or cancelled with their flow; never on a timer.
        import inspect
        source = inspect.getsource(Service)
        self.assertNotIn("wait_for(future", source)
        self.assertNotIn("15 * 60", source)


class OccupiedStartupPortTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_on_occupied_port_reports_error_and_recovers_after_port_change(self):
        directory = tempfile.TemporaryDirectory(prefix="streamglass-occupied-")
        self.addCleanup(directory.cleanup)
        occupied = await asyncio.start_server(lambda reader, writer: writer.close(), "127.0.0.1", 0)
        service = Service(directory.name, "lifecycle-only-token-1234567890", free_port())
        service.settings["proxyPort"] = occupied.sockets[0].getsockname()[1]
        try:
            with self.assertRaises(ValueError):
                await service.start_proxy()
            settings = service.state()["settings"]
            self.assertFalse(settings["proxyRunning"])
            self.assertIn("Proxyman", settings["proxyError"])
            service.settings["proxyPort"] = free_port()
            await service.start_proxy()
            self.assertTrue(service.state()["settings"]["proxyRunning"])
            self.assertEqual(service.state()["settings"]["proxyError"], "")
        finally:
            occupied.close()
            await occupied.wait_closed()
            if service.master:
                await service.master.addons.get("proxyserver").servers.update([])
                service.master.shutdown()
                await service.proxy_task
            service.db.close()

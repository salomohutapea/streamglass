import copy
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from backend.api import create_app
from backend.service import Service


class TrafficToolsRevisionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'test-token', 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={
            'Authorization': 'Bearer test-token', 'Host': '127.0.0.1:47821'})
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def test_missing_and_stale_revision_preserve_newer_config(self):
        initial = await (await self.client.get('/api/traffic-tools')).json()
        updated = copy.deepcopy(initial['config'])
        updated['network']['enabled'] = True
        updated['network']['delayMs'] = 250
        response = await self.client.put('/api/traffic-tools', json=updated)
        self.assertEqual(response.status, 428)
        self.assertEqual((await response.json())['error']['code'], 'revision_required')
        response = await self.client.put('/api/traffic-tools', json={'revision': initial['revision'], 'config': updated})
        self.assertEqual(response.status, 200)
        saved = await response.json()
        self.assertEqual(saved['revision'], initial['revision'] + 1)
        self.assertEqual(saved['config'], updated)
        response = await self.client.put('/api/traffic-tools', json={'revision': initial['revision'], 'config': initial['config']})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())['error']['code'], 'revision_conflict')
        self.assertEqual((await (await self.client.get('/api/traffic-tools')).json()), saved)
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.traffic_tools_revision, saved['revision'])
            self.assertEqual(restored.traffic_tools, updated)
        finally:
            restored.db.close()

    async def test_workspace_load_invalidates_stale_draft(self):
        initial = await (await self.client.get('/api/traffic-tools')).json()
        workspace = await (await self.client.get('/api/workspace-config')).json()
        workspace['trafficTools']['network']['enabled'] = True
        workspace['trafficTools']['network']['delayMs'] = 100
        response = await self.client.put('/api/workspace-config', json=workspace)
        self.assertEqual(response.status, 200)
        current = await (await self.client.get('/api/traffic-tools')).json()
        self.assertEqual(current['revision'], initial['revision'] + 1)
        response = await self.client.put('/api/traffic-tools', json={'revision': initial['revision'], 'config': initial['config']})
        self.assertEqual(response.status, 409)

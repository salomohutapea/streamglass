import copy
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from backend.api import create_app
from backend.service import Service


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'test-token', 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={'Authorization': 'Bearer test-token', 'Host': '127.0.0.1:47821'})
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def snapshot(self):
        return await (await self.client.get('/api/workspace-config')).json()

    async def test_round_trip_and_validation_before_apply(self):
        original = await self.snapshot()
        value = copy.deepcopy(original)
        value['tlsDomains'] = ['api.example.com']
        value['folders'] = [{'id': 'folder', 'name': 'Search', 'kind': 'scripts'}]
        value['rules'] = [{'id': 'script', 'pattern': '*', 'method': '*', 'stages': ['request'], 'breakpoint': False, 'folderId': 'folder', 'script': ''}]
        response = await self.client.put('/api/workspace-config', json=value)
        self.assertEqual(response.status, 200)
        self.assertEqual(await self.snapshot(), value)
        self.assertTrue(self.service.settings['proxyEnabled'])
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.rules, value['rules'])
            self.assertEqual(restored.settings['tlsDomains'], value['tlsDomains'])
        finally:
            restored.db.close()
        for invalid in ({**value, 'proxyEnabled': False}, {**value, 'folders': []}, {**value, 'folders': value['folders'] * 2}, {**value, 'tlsDomains': ['bad domain']}):
            response = await self.client.put('/api/workspace-config', json=invalid)
            self.assertEqual(response.status, 400)
            self.assertEqual(await self.snapshot(), value)

    async def test_codecs_exclude_keys_and_preserve_session_keys(self):
        value = await self.snapshot()
        value['codecs'] = [{'id': 'codec', 'name': 'Example', 'pattern': '*', 'kind': 'base64', 'enabled': True, 'allowEditing': False}]
        self.service.codec_keys['codec'] = 'session-secret'
        response = await self.client.put('/api/workspace-config', json=value)
        self.assertEqual(response.status, 200)
        self.assertNotIn('session-secret', str(await self.snapshot()))
        self.assertEqual(self.service.codec_keys['codec'], 'session-secret')
        value['codecs'][0]['key'] = 'bad-secret'
        response = await self.client.put('/api/workspace-config', json=value)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.service.codec_keys['codec'], 'session-secret')

    async def test_persistence_failure_restores_all_memory(self):
        original = await self.snapshot()
        value = copy.deepcopy(original)
        value['tlsDomains'] = ['new.example']
        with patch.object(self.service, 'persist_config', side_effect=RuntimeError('disk failure')):
            response = await self.client.put('/api/workspace-config', json=value)
            self.assertEqual(response.status, 500)
        self.assertEqual(await self.snapshot(), original)

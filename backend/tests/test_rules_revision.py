import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from backend.api import create_app
from backend.service import Service


class RuleRevisionTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_missing_and_stale_revision_cannot_replace_rules(self):
        first = {'id': 'first', 'pattern': '*', 'stages': ['request']}
        second = {'id': 'second', 'pattern': '*', 'stages': ['response']}
        original = await (await self.client.get('/api/state')).json()
        response = await self.client.put('/api/rules', json=[first])
        self.assertEqual(response.status, 428)
        self.assertEqual((await response.json())['error']['code'], 'revision_required')
        response = await self.client.put('/api/rules', json={'revision': original['rulesRevision'], 'rules': [first]})
        self.assertEqual(response.status, 200)
        saved = await response.json()
        self.assertEqual(saved['rules'], [first])
        self.assertEqual(saved['revision'], original['rulesRevision'] + 1)
        response = await self.client.put('/api/rules', json={'revision': original['rulesRevision'], 'rules': [second]})
        self.assertEqual(response.status, 409)
        conflict = await response.json()
        self.assertEqual(conflict['error']['code'], 'revision_conflict')
        self.assertEqual(conflict['rulesRevision'], saved['revision'])
        state = await (await self.client.get('/api/state')).json()
        self.assertEqual(state['rules'], [first])
        self.assertEqual(state['rulesRevision'], saved['revision'])

    async def test_revision_survives_restart_and_tracks_folder_rule_changes(self):
        folder = await (await self.client.post('/api/folders', json={'name': 'Search', 'kind': 'breakpoints'})).json()
        rule = {'id': 'first', 'pattern': '*', 'stages': ['request'], 'folderId': folder['id']}
        initial = (await (await self.client.get('/api/state')).json())['rulesRevision']
        response = await self.client.put('/api/rules', json={'revision': initial, 'rules': [rule]})
        self.assertEqual(response.status, 200)
        saved_revision = (await response.json())['revision']
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.rules_revision, saved_revision)
        finally:
            restored.db.close()
        response = await self.client.delete('/api/folders/' + folder['id'])
        self.assertEqual(response.status, 200)
        state = await (await self.client.get('/api/state')).json()
        self.assertEqual(state['rulesRevision'], saved_revision + 1)
        self.assertEqual(state['rules'], [{key: value for key, value in rule.items() if key != 'folderId'}])

    async def test_workspace_rule_replacement_invalidates_open_drafts(self):
        initial = (await (await self.client.get('/api/state')).json())['rulesRevision']
        workspace = await (await self.client.get('/api/workspace-config')).json()
        workspace['rules'] = [{'id': 'workspace', 'pattern': '*', 'stages': ['request']}]
        response = await self.client.put('/api/workspace-config', json=workspace)
        self.assertEqual(response.status, 200)
        state = await (await self.client.get('/api/state')).json()
        self.assertEqual(state['rulesRevision'], initial + 1)
        response = await self.client.put('/api/rules', json={'revision': initial, 'rules': []})
        self.assertEqual(response.status, 409)
        self.assertEqual(self.service.rules, workspace['rules'])

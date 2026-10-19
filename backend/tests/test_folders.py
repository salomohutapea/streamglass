import json
import sqlite3
import tempfile
import unittest
import uuid

from aiohttp.test_utils import TestClient, TestServer

from backend.api import create_app
from backend.service import Service


class FolderTests(unittest.IsolatedAsyncioTestCase):
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

    async def create(self, name='Search', kind='breakpoints'):
        response = await self.client.post('/api/folders', json={'name': name, 'kind': kind})
        self.assertEqual(response.status, 201)
        folder = await response.json()
        self.assertEqual(str(uuid.UUID(folder['id'])), folder['id'])
        return folder

    async def save_rules(self, rules):
        state = await (await self.client.get('/api/state')).json()
        return await self.client.put('/api/rules', json={'revision': state['rulesRevision'], 'rules': rules})

    async def test_create_rename_move_delete_and_restart(self):
        first = await self.create('  Search  ')
        second = await self.create('Checkout')
        self.assertEqual(first['name'], 'Search')
        response = await self.client.patch('/api/folders/' + first['id'], json={'name': '  Flights  '})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['name'], 'Flights')
        rule = {'id': 'legacy', 'pattern': '*', 'stages': ['request'], 'breakpoint': True,
                'folderId': first['id'], 'legacyExtra': {'preserved': True}}
        response = await self.save_rules([rule])
        self.assertEqual(response.status, 200)
        rule['folderId'] = second['id']
        response = await self.save_rules([rule])
        self.assertEqual(response.status, 200)
        ungrouped = {key: value for key, value in rule.items() if key != 'folderId'}
        response = await self.save_rules([ungrouped])
        self.assertEqual(response.status, 200)
        response = await self.save_rules([rule])
        self.assertEqual(response.status, 200)
        await self.client.delete('/api/folders/' + first['id'])
        self.assertEqual(self.service.rules, [rule])
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.folders, [second])
            self.assertEqual(restored.rules, [rule])
        finally:
            restored.db.close()
        response = await self.client.delete('/api/folders/' + second['id'])
        self.assertEqual(response.status, 200)
        state = await (await self.client.get('/api/state')).json()
        self.assertEqual(state['folders'], [])
        self.assertEqual(state['rules'], [ungrouped])
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.rules, [ungrouped])
            self.assertEqual(restored.folders, [])
        finally:
            restored.db.close()

    async def test_folder_validation_and_missing_ids(self):
        first = await self.create('Flights')
        second = await self.create('Checkout')
        await self.create('Flights', 'scripts')
        for value in ({'name': 'flights', 'kind': 'breakpoints'}, {'name': '   ', 'kind': 'scripts'},
                      {'name': 'x' * 129, 'kind': 'scripts'}, {'name': None, 'kind': 'scripts'},
                      {'name': 'Folder', 'kind': 'other'}, {'name': 'Folder', 'kind': []},
                      {'name': 'Folder', 'kind': 'scripts', 'parentId': first['id']}, []):
            response = await self.client.post('/api/folders', json=value)
            self.assertEqual(response.status, 400, value)
        for value in ({'name': ' FLIGHTS '}, {'name': ''}, {'name': 'Folder', 'kind': 'scripts'}, {}):
            response = await self.client.patch('/api/folders/' + second['id'], json=value)
            self.assertEqual(response.status, 400, value)
        for method in (self.client.patch, self.client.delete):
            response = await method('/api/folders/missing', json={'name': 'Folder'})
            self.assertEqual(response.status, 404)
        response = await self.client.options('/api/folders/' + first['id'], headers={'Origin': 'app://streamglass'})
        self.assertIn('PATCH', response.headers['Access-Control-Allow-Methods'])

    async def test_rules_reject_missing_or_cross_kind_folders_without_mutation(self):
        breakpoint = await self.create()
        script = await self.create(kind='scripts')
        rule = {'id': 'one', 'pattern': '*', 'stages': ['request']}
        for enabled, folder in ((True, breakpoint), (False, script)):
            saved = {**rule, 'breakpoint': enabled, 'folderId': folder['id']}
            response = await self.save_rules([saved])
            self.assertEqual(response.status, 200)
            for folder_id in ('missing', None, [], script['id'] if enabled else breakpoint['id']):
                response = await self.save_rules([{**saved, 'folderId': folder_id}])
                self.assertEqual(response.status, 400)
                self.assertEqual(self.service.rules, [saved])
        response = await self.save_rules([{**rule, 'folderId': breakpoint['id']}])
        self.assertEqual(response.status, 200)

    async def test_delete_rolls_back_rules_and_folders_on_database_failure(self):
        folder = await self.create()
        rule = {'id': 'one', 'pattern': '*', 'stages': ['request'], 'folderId': folder['id']}
        self.service.persist_config(rules=[rule])
        self.service.db.execute("CREATE TRIGGER reject_folders BEFORE INSERT ON config WHEN NEW.key = 'folders' BEGIN SELECT RAISE(ABORT, 'write failure'); END")
        self.service.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.persist_config(rules=[], folders=[])
        self.assertEqual(self.service.rules, [rule])
        self.assertEqual(self.service.folders, [folder])
        persisted = dict(self.service.db.execute('SELECT key,value FROM config'))
        self.assertEqual(json.loads(persisted['rules']), [rule])
        self.assertEqual(json.loads(persisted['folders']), [folder])

    async def test_legacy_configuration_defaults_to_empty_folders(self):
        rule = {'id': 'old', 'pattern': '*', 'stages': ['response'], 'extra': 'keep'}
        self.service.persist_config(rules=[rule])
        self.service.db.execute("DELETE FROM config WHERE key='folders'")
        self.service.db.commit()
        restored = Service(self.directory.name, 'test-token', 47821)
        try:
            self.assertEqual(restored.state()['folders'], [])
            self.assertEqual(restored.rules, [rule])
        finally:
            restored.db.close()

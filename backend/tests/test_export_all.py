import tempfile
import unittest
import os
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from backend.api import create_app
from backend.service import Service


class ExportAllTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'export-test-token-1234567890', 0)
        app = create_app(self.service)
        async def icon(request):
            return web.json_response(self.icon_reply)
        app.router.add_post('/application-icon', icon)
        server = TestServer(app)
        await server.start_server()
        self.service.port = server.port
        self.client = TestClient(server)
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def test_complete_retained_session_and_ignored_ui_filters(self):
        records = [
            {'id': 'sse', 'startedAt': 1, 'state': 'complete', 'device': 'phone',
             'request': {'headers': [['X-Test', 'one'], ['X-Test', 'two']], 'body': 'request', 'bodyBase64': 'cmVxdWVzdA=='},
             'response': {'statusCode': 200, 'headers': [['Content-Type', 'text/event-stream']]},
             'events': [{'sequence': 1, 'event': 'data', 'data': '{"value":9007199254740993}', 'raw': 'event: data\ndata: value\n\n'}]},
            {'id': 'streamed', 'startedAt': 2, 'state': 'complete', 'device': 'mac',
             'response': {'bodyUnavailable': True, 'bodyPreview': 'partial'}, 'captureWarning': 'Only preview retained'},
        ]
        for record in records:
            self.service.save(record)
        response = await self.client.get('/api/export-all?device=missing', headers={'Authorization': 'Bearer ' + self.service.token, 'Origin': 'app://streamglass'})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'app://streamglass')
        result = await response.json()
        self.assertEqual(result['format'], 'streamglass-session')
        self.assertEqual(result['recordCount'], 2)
        # Retained events may omit rawBase64 when raw is exact UTF-8; exports always carry it.
        records[0]['events'][0]['rawBase64'] = 'ZXZlbnQ6IGRhdGEKZGF0YTogdmFsdWUKCg=='
        self.assertEqual(result['records'], records)

    async def test_empty_session_and_authentication(self):
        self.assertEqual((await self.client.get('/api/export-all')).status, 401)
        response = await self.client.get('/api/export-all', headers={'Authorization': 'Bearer ' + self.service.token})
        self.assertEqual((await response.json())['records'], [])

    async def test_stored_icon_refresh_preserves_identity_and_rejects_mismatched_ids(self):
        icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
        app = {'id': 'app:/Applications/Fixture.app', 'name': 'Fixture', 'pid': 123, 'kind': 'application'}
        record = {'id': 'old', 'startedAt': 1, 'state': 'complete', 'application': app, 'clientIsLocal': True}
        self.service.save(record)
        with patch.dict(os.environ, {'STREAMGLASS_SCRIPT_URL': str(self.client.make_url('/')).rstrip('/')}):
            self.icon_reply = {'id': 'app:/Applications/Other.app', 'icon': icon}
            await self.service.refresh_application_icons()
            self.assertNotIn('icon', record['application'])
            self.icon_reply = {'id': app['id'], 'icon': icon}
            await self.service.refresh_application_icons()
        self.assertEqual(record['application'], {**app, 'icon': icon})

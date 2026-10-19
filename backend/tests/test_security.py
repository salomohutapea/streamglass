"""Management boundary regressions with synthetic data and an isolated profile."""
import base64
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from backend.api import create_app
from backend.service import Service
from backend.traffic_tools import DEFAULT_NETWORK


class ManagementSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'synthetic-management-token', 47821)
        self.client = TestClient(TestServer(create_app(self.service)))
        await self.client.start_server()
        self.host = '127.0.0.1:47821'
        self.auth = {'Authorization': 'Bearer synthetic-management-token', 'Host': self.host}

    async def asyncTearDown(self):
        await self.client.close()
        self.service.db.close()
        self.directory.cleanup()

    async def test_token_and_origin_are_checked_before_state_and_mutation(self):
        for method, path, body in (('get', '/api/state', None), ('put', '/api/settings', {'capturePaused': True})):
            for supplied in ('', 'Bearer wrong-token', 'synthetic-management-token', 'Bearer café'):
                headers = {'Host': self.host, 'Authorization': supplied, 'Origin': 'app://streamglass'}
                response = await getattr(self.client, method)(path, headers=headers, json=body)
                self.assertEqual(response.status, 401)
                self.assertEqual((await response.json())['error']['code'], 'unauthorized')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
            response = await getattr(self.client, method)(path, headers={**self.auth, 'Origin': 'null'}, json=body)
            self.assertEqual(response.status, 403)
            self.assertEqual((await response.json())['error']['code'], 'origin_denied')
            self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        self.assertFalse(self.service.settings['capturePaused'])

    async def test_exact_host_required_even_with_valid_token(self):
        for host in ('127.0.0.1:47822', 'localhost:47822', '127.0.0.1:47821.evil.test', 'evil.test:47821'):
            response = await self.client.get('/api/state', headers={**self.auth, 'Host': host})
            self.assertEqual(response.status, 403)
            self.assertEqual((await response.json())['error']['code'], 'host_denied')
        response = await self.client.get('/api/state', headers={**self.auth, 'Host': 'localhost:47821'})
        self.assertEqual(response.status, 200)

    async def test_websocket_query_token_does_not_authorize_rest(self):
        response = await self.client.get('/api/state?token=synthetic-management-token', headers={'Host': self.host})
        self.assertEqual(response.status, 401)
        self.assertEqual((await response.json())['error']['code'], 'unauthorized')

    async def test_preflight_is_narrow_and_invalid_fixture_header_is_atomic(self):
        response = await self.client.options('/api/settings', headers={'Host': self.host, 'Origin': 'app://streamglass'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'app://streamglass')
        response = await self.client.options('/api/settings', headers={'Host': self.host, 'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)

        before = self.service.traffic_tools
        value = {'mapLocalRules': [{'id': 'fixture', 'name': 'Fixture', 'enabled': True,
                                    'method': 'GET', 'pattern': '*', 'statusCode': 200,
                                    'headers': [['X-Test', 'safe\r\nInjected: yes']],
                                    'bodyBase64': base64.b64encode(b'fixture').decode()}],
                 'network': dict(DEFAULT_NETWORK)}
        response = await self.client.put('/api/traffic-tools', headers=self.auth,
            json={'revision': self.service.traffic_tools_revision, 'config': value})
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())['error']['code'], 'invalid_request')
        self.assertEqual(self.service.traffic_tools, before)

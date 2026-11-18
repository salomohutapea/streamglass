"""Management boundary regressions with synthetic data and an isolated profile."""
import base64
import asyncio
import hmac
import tempfile
import unittest
from types import SimpleNamespace

from aiohttp.test_utils import TestClient, TestServer
from mitmproxy import http

from backend.api import create_app
from backend.service import Service
from backend.traffic_tools import DEFAULT_NETWORK


class ManagementSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'synthetic-management-token', 47821)
        self.client = TestClient(TestServer(create_app(self.service, mcp_approval_key=b"synthetic-approval-key")))
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

    async def test_management_rejects_query_tokens_and_dev_origins_by_default(self):
        response = await self.client.get('/api/ws?token=synthetic-management-token', headers={'Host': self.host})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/api/state', headers={**self.auth, 'Origin': 'http://127.0.0.1:5173'})
        self.assertEqual(response.status, 403)

    async def test_breakpoint_approval_is_bound_to_the_engine_validated_edit(self):
        future = asyncio.get_running_loop().create_future()
        self.service.pending['gate'] = {'future': future, 'stage': 'request', 'value': {}, 'recordId': 'request'}
        self.service.flows['request'] = SimpleNamespace(request=http.Request.make('GET', 'https://api.example.test/'))
        value = {'url': 'https://staging.example.test/'}
        path = '/api/pending/gate'
        preview = await self.client.post(path + '/approval', headers=self.auth, json=value)
        self.assertEqual(preview.status, 200)
        approval = (await preview.json())['approval']
        self.assertEqual(approval['server'], 'https://staging.example.test:443')
        decision = {'action': 'continue', 'mcp': True, 'value': value}
        for proof, edit in ((approval['stamp'], value), (
                hmac.digest(b'synthetic-approval-key', approval['stamp'].encode(), 'sha256').hex(),
                {'url': 'https://staging.example.test/other'})):
            result = await self.client.post(path, headers=self.auth, json={**decision, 'approval': proof, 'value': edit})
            self.assertEqual(result.status, 403)
            self.assertFalse(future.done())
        proof = hmac.digest(b'synthetic-approval-key', approval['stamp'].encode(), 'sha256').hex()
        result = await self.client.post(path, headers=self.auth, json={**decision, 'approval': proof})
        self.assertEqual(result.status, 200)
        self.assertEqual(future.result(), value)

    async def test_tls_baseline_conflict_preserves_desktop_changes(self):
        self.service.settings['tlsDomains'] = ['desktop.example.test']
        result = await self.client.put('/api/settings', headers=self.auth,
            json={'tlsDomains': ['agent.example.test'], 'mcpTlsBaseline': []})
        self.assertEqual(result.status, 409)
        self.assertEqual(self.service.settings['tlsDomains'], ['desktop.example.test'])

    async def test_response_preview_contains_status_changed_headers_and_body_summary(self):
        future = asyncio.get_running_loop().create_future()
        self.service.pending['gate'] = {'future': future, 'stage': 'response', 'value': {}, 'recordId': 'response'}
        self.service.flows['response'] = SimpleNamespace(response=http.Response.make(200, b'old'), metadata={})
        response = await self.client.post('/api/pending/gate/approval', headers=self.auth,
            json={'statusCode': 201, 'body': 'new', 'headers': [['X-Example', 'updated']]})
        self.assertEqual(response.status, 200)
        summary = (await response.json())['approval']['changes']
        self.assertEqual(summary['status'], [200, 201])
        self.assertIn({'name': 'x-example', 'values': ['updated'], 'truncated': False}, summary['headers'])
        self.assertEqual(summary['body']['textPreview'], 'new')
        self.assertEqual(summary['body']['bytes'], 3)
        self.assertFalse(future.done())

    async def test_mcp_sse_edit_needs_approval(self):
        future = asyncio.get_running_loop().create_future()
        self.service.pending['event'] = {'future': future, 'stage': 'event', 'value': {'data': 'old'}, 'recordId': 'stream'}
        path = '/api/pending/event'
        result = await self.client.post(path, headers=self.auth,
            json={'action': 'continue', 'mcp': True, 'value': {'data': 'new'}})
        self.assertEqual(result.status, 403)
        self.assertFalse(future.done())

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

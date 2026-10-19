import asyncio
import base64
import unittest
from types import SimpleNamespace
from backend.codecs import transform, prepare_decoded, validate_profiles


class CodecTests(unittest.IsolatedAsyncioTestCase):
    def profile(self, kind='aes-cbc', compression='gzip'):
        return {'id': 'test', 'name': 'Test', 'enabled': True, 'pattern': '*', 'kind': kind, 'compression': compression, 'keyFormat': 'base64', 'allowEditing': True}

    def test_roundtrip_and_corrupt(self):
        for kind in ('base64', 'aes-cbc', 'aes-ctr'):
            p = self.profile(kind)
            encoded = transform(p, '{"nonce":"synthetic","unicode":"✓"}', b'0' * 16, True)
            self.assertEqual(transform(p, encoded, b'0' * 16), '{"nonce":"synthetic","unicode":"✓"}')
            with self.assertRaises(ValueError):
                transform(p, 'invalid!', b'0' * 16)
        with self.assertRaises(ValueError):
            transform(self.profile(), transform(self.profile(), 'hello', b'0' * 16, True), b'1' * 16)
        with self.assertRaises(ValueError):
            validate_profiles([{**self.profile(), 'key': 'never-save'}])

    async def test_noop_and_nonce_and_failure(self):
        p = self.profile()
        wire = transform(p, '{"context":{"nonce":"test"}}', b'0' * 16, True)
        value = {'body': wire, 'bodyBase64': 'original-raw', 'headers': [['x-nonce','test'], ['x-bundle-id','bundle']]}
        future = asyncio.get_running_loop().create_future()
        gate = {'stage':'response','url':'https://example.test','value':value,'future':future}
        service = SimpleNamespace(codecs=[p], codec_keys={'test':base64.b64encode(b'0'*16).decode()})
        same = await prepare_decoded(service, gate, {'codecId':'test','body':'{"context":{"nonce":"test"}}'}, value)
        self.assertEqual(same, value)
        changed = await prepare_decoded(service, gate, {'codecId':'test','body':'{"context":{"nonce":"test"},"ok":true}'}, value)
        self.assertEqual(changed['headers'], value['headers'])
        self.assertNotIn('bodyBase64', changed)
        service.codec_keys.clear()
        with self.assertRaises(ValueError):
            await prepare_decoded(service, gate, {'codecId':'test','body':'hello'}, value)
        self.assertFalse(future.done())

    async def test_sandbox_encode_failure_does_not_release(self):
        p = {**self.profile('custom-js'), 'decodeSource': '(body)=>body', 'encodeSource': '(body)=>{throw Error("synthetic") }'}
        from unittest.mock import AsyncMock, patch
        original = {'body':'original', 'headers':[]}
        gate = {'stage':'response','url':'https://example.test','value':original}
        service = SimpleNamespace(codecs=[p], codec_keys={})
        with patch('backend.codecs.convert', new=AsyncMock(side_effect=['original', ValueError('synthetic encode failure')])):
            with self.assertRaises(ValueError):
                await prepare_decoded(service, gate, {'codecId':'test','body':'edited'}, original)
        self.assertEqual(original['body'], 'original')

class CodecApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile
        from aiohttp.test_utils import TestClient, TestServer
        from backend.api import create_app
        from backend.service import Service
        self.temp = tempfile.TemporaryDirectory()
        self.service = Service(self.temp.name, 'synthetic', 47821)
        self.client = TestClient(TestServer(create_app(self.service)), headers={'Authorization':'Bearer synthetic','Host':'127.0.0.1:47821'})
        self.addAsyncCleanup(self.client.close)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.service.db.close)
        await self.client.start_server()

    async def test_session_key_not_persisted_and_stale_gate(self):
        profile = CodecTests().profile()
        self.assertEqual((await self.client.put('/api/codecs', json=[profile])).status, 200)
        self.assertEqual((await self.client.post('/api/codecs/test/key', json={'key':base64.b64encode(b'0'*16).decode()})).status, 200)
        stored = dict(self.service.db.execute('SELECT key,value FROM config'))
        self.assertNotIn(base64.b64encode(b'0'*16).decode(), str(stored))
        self.assertEqual(await (await self.client.get('/api/codecs')).json(), [profile])
        self.assertEqual((await self.client.post('/api/pending/missing/decode', json={})).status, 409)
        self.assertEqual((await self.client.put('/api/codecs', json=[{**profile, 'key':'secret'}])).status, 400)

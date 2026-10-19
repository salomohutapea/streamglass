"""Real loopback proxy coverage; never changes system proxy or trust settings."""
import asyncio
import base64
import time
import gzip
import hashlib
import io
import json
import os
import socket
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from backend.service import Service
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class ProxyIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='streamglass-test-')
        self.port, self.proxy_port = free_port(), free_port()
        self.token = 'integration-only-token-1234567890'
        service = Service(self.directory.name, self.token, self.port)
        service.settings['proxyPort'] = self.proxy_port
        service.persist_config()
        service.db.close()
        app = web.Application()
        self.script_calls = []
        self.script_started, self.script_release = asyncio.Event(), asyncio.Event()
        async def script(request):
            payload = await request.json()
            self.script_calls.append(payload['hook'])
            self.script_started.set()
            if payload['source'] == 'slow-pause-test':
                await self.script_release.wait()
            stage = {'onRequest': 'request', 'onResponse': 'response', 'onEvent': 'event'}[payload['hook']]
            value = payload[stage]
            value['data' if stage == 'event' else 'body'] = 'script changed'
            return web.json_response({'value': value})
        app.router.add_post('/execute', script)
        self.origin_hits = 0
        async def rest(request):
            self.origin_hits += 1
            return web.Response(body=await request.read(), headers={'X-Origin': 'yes', **({'X-Nonce': request.headers['X-Nonce']} if 'X-Nonce' in request.headers else {})})
        self.compressed_payload = b'expanded payload\n' * (600 * 1024)
        self.compressed_wire = gzip.compress(self.compressed_payload)
        async def compressed_large(request):
            return web.Response(body=self.compressed_wire, headers={
                'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip'})
        async def websocket(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for message in ws:
                await ws.send_str(message.data)
            return ws
        async def events(request):
            raw = b': heartbeat\r\n\r\nid: 1\r\ndata: first\r\n\r\ndata: second\n\n'
            if request.query.get('large'):
                raw = b'event: context\ndata: {}\n\n' + (b'event: data\ndata: ' + b'x' * (1200 * 1024) + b'\n\n') * int(request.query.get('count', 2))
            if request.query.get('oversized'):
                raw = b'data: ' + b'x' * int(request.query.get('size', 8 * 1024 * 1024 + 1)) + b'\n\n'
            if request.query.get('gzip'):
                return web.Response(body=gzip.compress(raw), headers={'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip'})
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            for chunk in (raw[:13], raw[13:35], raw[35:]):
                await response.write(chunk)
                await asyncio.sleep(.02)
            return response
        async def bundle(request):
            response = web.StreamResponse(headers={
                'Content-Type': 'application/javascript',
                'X-Request-Host': request.host,
                'X-Request-Query': request.query_string,
            })
            await response.prepare(request)
            for _ in range(160):
                await response.write(b'/* metro bundle */\n' + b' ' * (64 * 1024 - 19))
            return response
        app.router.add_route('*', '/rest', rest)
        app.router.add_get('/compressed-large', compressed_large)
        app.router.add_get('/message', websocket)
        app.router.add_get('/hot', websocket)
        app.router.add_get('/index.bundle', bundle)
        app.router.add_get('/events', events)
        self.origin = web.AppRunner(app)
        await self.origin.setup()
        site = web.TCPSite(self.origin, '127.0.0.1', 0)
        await site.start()
        self.url = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, 'localhost')])
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                       .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
                       .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
                       .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'), x509.IPAddress(ip_address('127.0.0.1'))]), False)
                       .add_extension(x509.BasicConstraints(ca=True, path_length=None), True).sign(key, hashes.SHA256()))
        self.origin_cert = Path(self.directory.name, 'origin.pem')
        self.origin_cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        origin_key = Path(self.directory.name, 'origin.key')
        origin_key.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.origin_cert, origin_key)
        tls_site = web.TCPSite(self.origin, '127.0.0.1', 0, ssl_context=tls)
        await tls_site.start()
        self.tls_port = tls_site._server.sockets[0].getsockname()[1]
        self.tls_url = f'https://127.0.0.1:{self.tls_port}'
        other_tls_site = web.TCPSite(self.origin, '127.0.0.1', 0, ssl_context=tls)
        await other_tls_site.start()
        self.other_tls_port = other_tls_site._server.sockets[0].getsockname()[1]
        self.log = open(Path(self.directory.name) / 'engine.log', 'wb')
        executable = os.environ.get('STREAMGLASS_TEST_ENGINE')
        # Only this child process trusts the temporary origin certificate.
        command = [executable] if executable else [sys.executable, '-c',
            f'import certifi; certifi.where = lambda: {str(self.origin_cert)!r}; from backend.__main__ import main; main()']
        self.process = await asyncio.create_subprocess_exec(*command, '--port', str(self.port), '--token', self.token, '--data-dir', self.directory.name, stdout=asyncio.subprocess.PIPE, stderr=self.log,
            env={**os.environ, 'STREAMGLASS_SCRIPT_URL': self.url})
        try:
            ready = await asyncio.wait_for(self.process.stdout.readline(), 20)
            self.assertEqual(json.loads(ready)['type'], 'ready')
        except Exception:
            if self.process.returncode is None:
                self.process.terminate()
            await self.process.wait()
            self.log.close()
            raise AssertionError(Path(self.directory.name, 'engine.log').read_text())
        self.client = ClientSession(timeout=ClientTimeout(total=10))
        self.api = f'http://127.0.0.1:{self.port}/api'
        self.auth = {'Authorization': 'Bearer ' + self.token}
        self.proxy = f'http://127.0.0.1:{self.proxy_port}'

    async def asyncTearDown(self):
        self.script_release.set()
        await self.client.close()
        self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 10)
        self.log.close()
        log = Path(self.directory.name, "engine.log").read_text()
        if log:
            print(log[-6000:])
        await self.origin.cleanup()
        self.directory.cleanup()

    async def state(self):
        async with self.client.get(self.api + '/state', headers=self.auth) as response:
            self.assertEqual(response.status, 200)
            return await response.json()

    async def rules_payload(self, rules):
        return {'revision': (await self.state())['rulesRevision'], 'rules': rules}

    async def traffic_tools_payload(self, config):
        async with self.client.get(self.api + '/traffic-tools', headers=self.auth) as response:
            self.assertEqual(response.status, 200)
            return {'revision': (await response.json())['revision'], 'config': config}

    async def wait_for(self, predicate):
        for _ in range(100):
            state = await self.state()
            if predicate(state):
                return state
            await asyncio.sleep(.03)
        self.fail('State did not reach expected condition: ' + repr(state))

    async def capture(self, suffix):
        async with self.client.get(self.url + suffix, proxy=self.proxy) as response:
            return await response.read()

    async def settings(self, changes):
        async with self.client.put(self.api + '/settings', headers=self.auth, json=changes) as response:
            self.assertEqual(response.status, 200)
            return await response.json()

    async def test_paused_proxy_skips_all_rules_and_preserves_compressed_sse(self):
        rules = [{'id': 'all', 'pattern': '*', 'stages': ['request', 'response', 'event'],
                  'script': 'pause-test', 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        await self.settings({'capturePaused': True})
        async with self.client.post(self.url + '/rest', proxy=self.proxy, data=b'original\x00\xff') as response:
            self.assertEqual(await response.read(), b'original\x00\xff')
        async with self.client.get(self.url + '/events?gzip=1', proxy=self.proxy, auto_decompress=False) as response:
            self.assertEqual(response.headers.get('Content-Encoding'), 'gzip')
            raw = await response.read()
            self.assertEqual(gzip.decompress(raw), b': heartbeat\r\n\r\nid: 1\r\ndata: first\r\n\r\ndata: second\n\n')
        state = await self.state()
        self.assertFalse(state['records'])
        self.assertFalse(state['pending'])
        self.assertFalse(self.script_calls)

    async def test_pause_releases_scripted_request_response_and_event_originals(self):
        for stage in ('request', 'response', 'event'):
            await self.settings({'capturePaused': False})
            rules = [{'id': 'gate', 'pattern': '*', 'stages': [stage], 'script': 'pause-test', 'breakpoint': True}]
            async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
                self.assertEqual(response.status, 200)
            async def exchange():
                suffix = '/events' if stage == 'event' else '/rest'
                request = self.client.get(self.url + suffix, proxy=self.proxy) if stage == 'event' else self.client.post(self.url + suffix, proxy=self.proxy, data=b'original')
                async with request as response:
                    return await response.read()
            task = asyncio.create_task(exchange())
            state = await self.wait_for(lambda s: bool(s['pending']))
            self.assertEqual(state['pending'][0]['value']['data' if stage == 'event' else 'body'], 'script changed')
            await self.settings({'capturePaused': True})
            expected = b': heartbeat\r\n\r\nid: 1\r\ndata: first\r\n\r\ndata: second\n\n' if stage == 'event' else b'original'
            self.assertEqual(await task, expected)
            await self.wait_for(lambda s: not s['pending'])

    async def test_pause_cancels_awaited_script_and_resume_cannot_apply_late_result(self):
        rules = [{'id': 'slow', 'pattern': '*', 'stages': ['request'], 'script': 'slow-pause-test', 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        async def exchange():
            async with self.client.post(self.url + '/rest', proxy=self.proxy, data=b'original') as response:
                return await response.read()
        task = asyncio.create_task(exchange())
        await asyncio.wait_for(self.script_started.wait(), 5)
        await self.settings({'capturePaused': True})
        await self.settings({'capturePaused': False})
        self.assertEqual(await asyncio.wait_for(task, 2), b'original')
        self.script_release.set()
        self.assertFalse((await self.state())['pending'])

    async def test_rest_auth_websocket_capture_export_and_delete(self):
        async with self.client.get(self.api + '/state') as response:
            self.assertEqual(response.status, 401)
        async with self.client.get(self.api + '/state', headers={**self.auth, 'Origin': 'https://untrusted.invalid'}) as response:
            self.assertEqual(response.status, 403)
        async with self.client.ws_connect(self.api + '/ws', headers=self.auth) as ws:
            self.assertEqual((await ws.receive_json())['type'], 'state')
            async with self.client.post(self.url + '/rest', data=b'\x00binary\xff', proxy=self.proxy) as response:
                self.assertEqual(await response.read(), b'\x00binary\xff')
            state = await self.wait_for(lambda s: s['records'] and s['records'][0]['state'] == 'complete')
            record_id = state['records'][0]['id']
            async with self.client.get(self.api + '/export/' + record_id, headers=self.auth) as response:
                self.assertEqual((await response.json())['method'], 'POST')
            async with self.client.delete(self.api + '/records/' + record_id, headers=self.auth) as response:
                self.assertEqual((await response.json())['deleted'], 1)

    async def test_sse_preserves_wire_and_decompresses(self):
        expected = b': heartbeat\r\n\r\nid: 1\r\ndata: first\r\n\r\ndata: second\n\n'
        for suffix in ('/events', '/events?gzip=1'):
            self.assertEqual(await self.capture(suffix), expected)
        state = await self.wait_for(lambda s: len(s['records']) == 2 and all(r['state'] == 'complete' for r in s['records']))
        self.assertEqual([r['eventCount'] for r in state['records']], [2, 2])

    async def test_compressed_rest_expansion_limits_capture_without_changing_forwarding(self):
        expected = self.compressed_payload
        self.assertGreater(len(expected), 8 * 1024 * 1024)
        wire = self.compressed_wire
        self.assertLess(len(wire), 8 * 1024 * 1024)
        async with self.client.get(self.url + '/compressed-large', proxy=self.proxy, auto_decompress=False) as response:
            self.assertEqual(response.headers.get('Content-Encoding'), 'gzip')
            self.assertEqual(await response.read(), wire)
        state = await self.wait_for(lambda s: bool(s['records']) and s['records'][0]['state'] == 'complete')
        async with self.client.get(self.api + '/records/' + state['records'][0]['id'], headers=self.auth) as response:
            self.assertEqual(response.status, 200)
            capture = await response.json()
        self.assertTrue(capture['response']['bodyUnavailable'])
        self.assertEqual(capture['response']['body'], '')
        self.assertEqual(base64.b64decode(capture['response']['bodyBase64']), wire)
        self.assertIn('inspection limit', capture['response']['bodyUnavailableReason'])
        self.assertEqual(gzip.decompress(wire), expected)

    async def test_large_sse_events_preserve_wire_and_decompress(self):
        expected = b'event: context\ndata: {}\n\n' + (b'event: data\ndata: ' + b'x' * (1200 * 1024) + b'\n\n') * 2
        for suffix in ('/events?large=1', '/events?large=1&gzip=1'):
            self.assertEqual(await self.capture(suffix), expected)
        state = await self.wait_for(lambda s: len(s['records']) == 2 and all(r['state'] == 'complete' for r in s['records']))
        self.assertEqual([r['eventCount'] for r in state['records']], [3, 3])

    async def test_large_compressed_stream_continues_after_capture_limit(self):
        expected = b'event: context\ndata: {}\n\n' + (b'event: data\ndata: ' + b'x' * (1200 * 1024) + b'\n\n') * 15
        self.assertEqual(await self.capture('/events?large=1&gzip=1&count=15'), expected)
        state = await self.wait_for(lambda s: bool(s['records']) and s['records'][0]['state'] == 'complete')
        record = state['records'][0]
        self.assertEqual(record['eventCount'], 16)
        async with self.client.get(self.api + '/records/' + record['id'], headers=self.auth) as response:
            capture = await response.json()
        self.assertTrue(capture['captureWarning'])
        self.assertLess(len(capture['events']), 16)

    async def test_huge_sse_event_streams_exactly_without_capture(self):
        expected = b'data: ' + b'x' * (20 * 1024 * 1024) + b'\n\n'
        for coding in ('', '&gzip=1'):
            self.assertEqual(await self.capture('/events?oversized=1&size=20971520' + coding), expected)
        state = await self.wait_for(lambda s: len(s['records']) == 2 and all(r['state'] == 'complete' for r in s['records']))
        for record in state['records']:
            async with self.client.get(self.api + '/records/' + record['id'], headers=self.auth) as response:
                capture = await response.json()
            self.assertIn('remaining stream forwarded', capture['captureWarning'])
            self.assertEqual(capture['events'], [])

    async def test_oversized_sse_retains_first_error(self):
        rules = [{'id': 'event', 'pattern': self.url + '/events*', 'stages': ['event'], 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        try:
            await self.capture('/events?oversized=1&gzip=1')
        except ClientError:
            pass
        state = await self.wait_for(lambda s: bool(s['records']) and s['records'][0]['state'] == 'error')
        self.assertEqual(state['records'][0]['error'], 'SSE event exceeds 8 MiB event-editing limit; disable matching event rules to stream larger events')

    async def test_websocket_upgrade_passes_without_reconnect_error(self):
        async with self.client.ws_connect(self.url + '/message', proxy=self.proxy) as ws:
            await ws.send_str('hello')
            self.assertEqual((await ws.receive()).data, 'hello')
        state = await self.wait_for(lambda s: bool(s['records']) and s['records'][0]['state'] == 'complete')
        self.assertEqual(state['records'][0]['statusCode'], 101)
        self.assertIsNone(state['records'][0]['error'])

    async def test_metro_localhost_chunked_bundle_and_hot_websocket(self):
        origin = self.url.replace('127.0.0.1', 'localhost')
        query = 'platform=android&dev=true&minify=false'
        expected = hashlib.sha256((b'/* metro bundle */\n' + b' ' * (64 * 1024 - 19)) * 160).hexdigest()
        async with self.client.get(origin + '/index.bundle?' + query, proxy=self.proxy) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['X-Request-Host'], origin.removeprefix('http://'))
            self.assertEqual(response.headers['X-Request-Query'], query)
            digest, size = hashlib.sha256(), 0
            async for chunk in response.content.iter_chunked(64 * 1024):
                digest.update(chunk)
                size += len(chunk)
            self.assertEqual(size, 64 * 1024 * 160)
            self.assertEqual(digest.hexdigest(), expected)
        async with self.client.ws_connect(origin + '/hot?platform=android&bundleEntry=index', proxy=self.proxy) as ws:
            message = '{"type":"update","body":{"isInitialUpdate":false}}'
            await ws.send_str(message)
            self.assertEqual((await ws.receive()).data, message)
        state = await self.wait_for(lambda s: len(s['records']) == 2 and all(r['state'] == 'complete' for r in s['records']))
        self.assertTrue(all(r['error'] is None for r in state['records']))
        self.assertEqual(sorted(r['statusCode'] for r in state['records']), [101, 200])

    async def test_event_breakpoint_edit_allows_concurrent_flow(self):
        rules = [{'id': 'event', 'pattern': self.url + '/events?pause=1', 'stages': ['event'], 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        paused = asyncio.create_task(self.capture('/events?pause=1'))
        state = await self.wait_for(lambda s: bool(s['pending']))
        self.assertIn(b'data: second', await self.capture('/events'))
        for sequence in (1, 2):
            state = await self.wait_for(lambda s: bool(s['pending']) and s['pending'][0]['value']['sequence'] == sequence)
            gate = state['pending'][0]
            value = {**gate['value'], 'data': f'edited {sequence}'}
            async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action': 'continue', 'value': value}) as response:
                self.assertEqual(response.status, 200)
        wire = await paused
        self.assertIn(b'data: edited 1\n', wire)
        self.assertIn(b'data: edited 2\n', wire)
        state = await self.wait_for(lambda s: not s['pending'] and all(r['state'] == 'complete' for r in s['records']))
        self.assertEqual(len(state['records']), 2)

    async def test_request_and_response_breakpoints_edit_actual_wire(self):
        rules = [{'id': 'rest', 'pattern': self.url + '/rest', 'stages': ['request', 'response'], 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        async def exchange():
            async with self.client.post(self.url + '/rest', data='before', proxy=self.proxy) as response:
                return response.status, await response.text()
        pending = asyncio.create_task(exchange())
        for stage, changes in [('request', {'body': 'request edited'}), ('response', {'statusCode': 201, 'body': 'response edited'})]:
            state = await self.wait_for(lambda s: bool(s['pending']) and s['pending'][0]['stage'] == stage)
            gate = state['pending'][0]
            if stage == 'response':
                self.assertEqual(gate['value']['body'], 'request edited')
            async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action': 'continue', 'value': {**gate['value'], **changes}}) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(await pending, (201, 'response edited'))
        async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action': 'continue'}) as response:
            self.assertEqual(response.status, 409)

    async def test_https_tunnel_then_inspection_on_new_connection(self):
        rules = [{'id': 'https', 'pattern': '*', 'stages': ['request', 'response', 'event'], 'breakpoint': True}]
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload(rules)) as response:
            self.assertEqual(response.status, 200)
        # Trust only the origin: an inspecting proxy would fail this TLS handshake.
        async with ClientSession() as tunnel_client:
            async with tunnel_client.post(self.tls_url + '/rest', proxy=self.proxy, data='opaque', ssl=ssl.create_default_context(cafile=str(self.origin_cert))) as response:
                self.assertEqual(await response.text(), 'opaque')
            state = await self.wait_for(lambda s: len(s['records']) == 1)
            tunnel = state['records'][0]
            self.assertEqual((tunnel['kind'], tunnel['method'], tunnel['url']), ('tunnel', 'CONNECT', f'127.0.0.1:{self.tls_port}'))
            self.assertTrue(tunnel['isEncrypted'])
            self.assertFalse(state['pending'])
            async with self.client.get(self.api + '/records/' + tunnel['id'], headers=self.auth) as response:
                self.assertNotIn('request', await response.json())
            async with self.client.get(self.api + '/export/' + tunnel['id'] + '?format=curl', headers=self.auth) as response:
                self.assertEqual(response.status, 400)
        await self.wait_for(lambda s: s['records'][0]['state'] == 'complete')
        if os.environ.get('STREAMGLASS_TEST_ENGINE'):
            # Frozen engine keeps its production CA bundle; source verifies inspection below.
            return
        async with self.client.put(self.api + '/settings', headers=self.auth, json={'tlsDomains': ['127.0.0.1']}) as response:
            self.assertEqual(response.status, 200)
        proxy_ca = Path(self.directory.name, 'mitmproxy', 'mitmproxy-ca-cert.pem')
        async def inspected_exchange():
            async with ClientSession() as inspected_client:
                async with inspected_client.post(self.tls_url + '/rest', proxy=self.proxy, data='before', ssl=ssl.create_default_context(cafile=str(proxy_ca))) as response:
                    return response.status, await response.text()
        exchange = asyncio.create_task(inspected_exchange())
        for stage, body in [('request', 'inspected request'), ('response', 'inspected response')]:
            state = await self.wait_for(lambda s: bool(s['pending']) and s['pending'][0]['stage'] == stage)
            gate = state['pending'][0]
            async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth,
                                        json={'action': 'continue', 'value': {**gate['value'], 'body': body}}) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(await exchange, (200, 'inspected response'))
        state = await self.wait_for(lambda s: len(s['records']) == 2 and all(r['state'] == 'complete' for r in s['records']))
        self.assertEqual([r['kind'] for r in state['records']], ['request', 'tunnel'])
        self.assertTrue(state['records'][0]['sslInspected'])
        self.assertFalse(state['records'][0]['isEncrypted'])

    async def test_enabling_inspection_interrupts_only_matching_live_tunnels(self):
        if os.environ.get('STREAMGLASS_TEST_ENGINE'):
            self.skipTest('Source fixture supplies the temporary origin CA to the proxy')

        async def settings(value, count=0):
            async with self.client.put(self.api + '/settings', headers=self.auth, json=value) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual((await response.json())['interruptedConnections'], count)

        writers = []
        async def connect(host='127.0.0.1', ca=None, port=None):
            port = port or self.tls_port
            reader, writer = await asyncio.open_connection('127.0.0.1', self.proxy_port)
            writers.append(writer)
            writer.write(f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())
            await writer.drain()
            self.assertIn(b' 200 ', await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5))
            context = ssl.create_default_context(cafile=str(ca or self.origin_cert))
            await writer.start_tls(context, server_hostname=host)
            return reader, writer

        async def exchange(connection, body=b'reused'):
            reader, writer = connection
            writer.write(f'POST /rest?reused=1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
            await writer.drain()
            self.assertIn(b' 200 ', await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5))
            self.assertEqual(await asyncio.wait_for(reader.readexactly(len(body)), 5), body)

        try:
            retained = await connect()
            await exchange(retained)
            await exchange(retained)
            state = await self.wait_for(lambda s: len(s['records']) == 1)
            retained_id = state['records'][0]['id']
            deleted = await connect()
            await exchange(deleted)
            state = await self.wait_for(lambda s: len(s['records']) == 2)
            deleted_id = next(r['id'] for r in state['records'] if r['id'] != retained_id)
            async with self.client.delete(self.api + '/records/' + deleted_id, headers=self.auth) as response:
                self.assertEqual(response.status, 200)
            await settings({'capturePaused': True})
            paused = await connect()
            await exchange(paused)
            await settings({'capturePaused': False})
            unrelated = await connect(port=self.other_tls_port)
            await exchange(unrelated)
            domain = f'127.0.0.1:{self.tls_port}'
            await settings({'tlsDomains': [domain]}, 3)
            for reader, _ in (retained, deleted, paused):
                self.assertEqual(await asyncio.wait_for(reader.read(), 5), b'')
            await exchange(unrelated)
            state = await self.state()
            record = next(r for r in state['records'] if r['id'] == retained_id)
            self.assertEqual(record['state'], 'interrupted')
            self.assertIsNone(record['error'])
            self.assertIn('enable SSL inspection', record['interruptionReason'])
            self.assertGreaterEqual(record['durationMs'], 0)
            self.assertNotIn(deleted_id, [r['id'] for r in state['records']])

            proxy_ca = Path(self.directory.name, 'mitmproxy', 'mitmproxy-ca-cert.pem')
            inspected = await connect(ca=proxy_ca)
            await exchange(inspected)
            state = await self.wait_for(lambda s: any(r.get('sslInspected') and '/rest?reused=1' in r['url'] for r in s['records']))
            # Changing the list must not interrupt a connection already decrypted.
            await settings({'tlsDomains': []})
            await settings({'tlsDomains': [domain]})
            await exchange(inspected)
            # A new opaque connection after removal can be interrupted on re-add.
            await settings({'tlsDomains': []})
            readded = await connect()
            await exchange(readded)
            await settings({'tlsDomains': [domain]}, 1)
            self.assertEqual(await asyncio.wait_for(readded[0].read(), 5), b'')
        finally:
            for writer in writers:
                writer.close()
            await asyncio.gather(*(writer.wait_closed() for writer in writers), return_exceptions=True)

    async def set_traffic_tools(self, *, body=None, network=None):
        from backend.traffic_tools import DEFAULT_NETWORK
        rules = [] if body is None else [{'id': 'local', 'name': 'Synthetic local fixture', 'enabled': True,
                                         'method': '*', 'pattern': self.url + '/rest*', 'statusCode': 201,
                                         'headers': [['Content-Type', 'text/plain']],
                                         'bodyBase64': base64.b64encode(body).decode()}]
        async with self.client.put(self.api + '/traffic-tools', headers=self.auth,
                                   json=await self.traffic_tools_payload({'mapLocalRules': rules, 'network': {**DEFAULT_NETWORK, **(network or {})}})) as response:
            self.assertEqual(response.status, 200, await response.text())

    async def test_map_local_skips_origin_and_response_gate_sees_script(self):
        await self.set_traffic_tools(body=b'local fixture')
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload([
                {'id': 'script', 'pattern': '*', 'stages': ['response'], 'script': 'edit', 'breakpoint': False},
                {'id': 'gate', 'pattern': '*', 'stages': ['response'], 'breakpoint': True}])) as response:
            self.assertEqual(response.status, 200)
        task = asyncio.create_task(self.capture('/rest?mapped=1'))
        state = await self.wait_for(lambda s: len(s['pending']) == 1)
        self.assertEqual(state['pending'][0]['value']['body'], 'script changed')
        self.assertEqual(self.origin_hits, 0)
        async with self.client.post(self.api + '/pending/' + state['pending'][0]['token'], headers=self.auth,
                                    json={'action': 'continue'}) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(await task, b'script changed')
        self.assertEqual(self.origin_hits, 0)

    async def test_pause_local_response_gate_fetches_original_origin(self):
        await self.set_traffic_tools(body=b'must not reach client')
        async with self.client.put(self.api + '/rules', headers=self.auth,
                                   json=await self.rules_payload([{'id': 'request-edit', 'pattern': '*', 'stages': ['request'], 'script': 'edit', 'breakpoint': False},
                                         {'id': 'gate', 'pattern': '*', 'stages': ['response'], 'breakpoint': True}])) as response:
            self.assertEqual(response.status, 200)
        async def post_original():
            async with self.client.post(self.url + '/rest?pause-map=1', proxy=self.proxy, data=b'original POST body') as response:
                return await response.read()
        task = asyncio.create_task(post_original())
        await self.wait_for(lambda s: len(s['pending']) == 1)
        await self.settings({'capturePaused': True})
        self.assertEqual(await task, b'original POST body')
        self.assertEqual(self.origin_hits, 1)

    async def test_oversized_map_upload_never_contacts_origin(self):
        await self.set_traffic_tools(body=b'local')
        async def chunked():
            for _ in range(129):
                yield b'x' * (64 * 1024)
                await asyncio.sleep(0)
        for payload in (io.BytesIO(b'x' * (8 * 1024 * 1024 + 1)), chunked()):
            try:
                async with self.client.post(self.url + '/rest', proxy=self.proxy, data=payload) as response:
                    await response.read()
                    self.assertGreaterEqual(response.status, 400)
            except ClientError:
                pass
            self.assertEqual(self.origin_hits, 0)
        state = await self.wait_for(lambda s: len([r for r in s['records'] if 'no upstream request' in (r.get('error') or '')]) == 2)
        self.assertTrue(state['records'])

    async def test_network_throttle_keeps_sse_incremental(self):
        await self.set_traffic_tools(network={'enabled': True, 'downloadKbps': 1, 'hostPattern': '127.0.0.1'})
        started = time.monotonic()
        async with self.client.get(self.url + '/events', proxy=self.proxy) as response:
            first = await response.content.readany()
            self.assertTrue(first)
            self.assertNotIn(b'data: second', first)
            raw = first + await response.read()
        self.assertIn(b'data: first', raw)
        self.assertIn(b'data: second', raw)
        self.assertGreater(time.monotonic() - started, .25)

    async def test_pause_bypasses_map_and_cancels_network_delay(self):
        await self.set_traffic_tools(body=b'mapped', network={'enabled': True, 'delayMs': 60000,
                                                            'uploadKbps': 1, 'downloadKbps': 1})
        async def post():
            async with self.client.post(self.url + '/rest?pause-delay=1', proxy=self.proxy,
                                        data=b'original request') as response:
                self.assertEqual(response.status, 200)
                return await response.read()
        task = asyncio.create_task(post())
        await asyncio.sleep(.1)
        started = time.monotonic()
        await self.settings({'capturePaused': True})
        self.assertEqual(await asyncio.wait_for(task, 2), b'original request')
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(self.origin_hits, 1)
        await self.settings({'capturePaused': False})

    async def test_pause_stops_network_waits_during_incremental_sse(self):
        await self.set_traffic_tools(body=b'mapped', network={'enabled': True, 'downloadKbps': 1})
        async with self.client.get(self.url + '/events', proxy=self.proxy) as response:
            first = await response.content.readany()
            await self.settings({'capturePaused': True})
            started = time.monotonic()
            raw = first + await asyncio.wait_for(response.read(), 1)
            self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(raw, b': heartbeat\r\n\r\nid: 1\r\ndata: first\r\n\r\ndata: second\n\n')

    async def test_network_upload_and_download_preserve_bytes(self):
        await self.set_traffic_tools(network={'enabled': True, 'uploadKbps': 64, 'downloadKbps': 64})
        original = bytes(range(256)) * 16
        started = time.monotonic()
        async with self.client.post(self.url + '/rest?rates=1', proxy=self.proxy, data=original) as response:
            headers_at = time.monotonic()
            self.assertEqual(await response.read(), original)
        self.assertGreater(headers_at - started, .4)
        self.assertGreater(time.monotonic() - started, .9)
        self.assertEqual(self.origin_hits, 1)

    async def test_lab_replay_and_timed_fixture(self):
        async with self.client.post(self.api + '/replay', headers=self.auth, json={
                'url': self.url + '/rest', 'method': 'POST', 'headers': [['X-Sent', 'explicit'], ['Host', 'stale.invalid'], ['Connection', 'keep-alive']],
                'bodyBase64': base64.b64encode(b'replay body').decode()}) as response:
            self.assertEqual(response.status, 202, await response.text())
            record_id = (await response.json())['id']
        await self.wait_for(lambda state: any(record['id'] == record_id and record['state'] == 'complete' for record in state['records']))
        async with self.client.get(self.api + '/records/' + record_id, headers=self.auth) as response:
            record = await response.json()
            self.assertEqual(record['response']['body'], 'replay body')
            headers = {key.lower(): value for key, value in record['request']['headers']}
            self.assertEqual(headers['host'], self.url.removeprefix('http://'))
            self.assertNotIn('connection', headers)
        tools = {'network': {'enabled': False, 'delayMs': 0, 'downloadKbps': 0, 'uploadKbps': 0, 'hostPattern': '*', 'deviceId': ''}, 'mapLocalRules': [{
            'id': 'timed', 'name': 'Timed', 'enabled': True, 'method': 'GET', 'pattern': self.url + '/events',
            'statusCode': 200, 'headers': [['Content-Type', 'text/event-stream']],
            'bodyBase64': base64.b64encode(b'data: one\n\ndata: two\n\n').decode(), 'eventDelaysMs': [0, 250]}]}
        async with self.client.put(self.api + '/traffic-tools', headers=self.auth, json=await self.traffic_tools_payload(tools)) as response:
            self.assertEqual(response.status, 200, await response.text())
        async with self.client.get(self.url + '/events', proxy=self.proxy) as response:
            self.assertEqual(await response.content.readexactly(11), b'data: one\n\n')
            first = time.monotonic()
            self.assertEqual(await response.content.read(), b'data: two\n\n')
            self.assertGreater(time.monotonic() - first, .18)
        state = await self.wait_for(lambda state: any(record['url'] == self.url + '/events' and record['state'] == 'complete' for record in state['records']))
        captured = next(record for record in state['records'] if record['url'] == self.url + '/events')
        async with self.client.post(self.api + '/records/' + captured['id'] + '/fixture', headers=self.auth, json={'name': 'Saved events', 'timedSse': True}) as response:
            self.assertEqual(response.status, 201, await response.text())
            fixture = await response.json()
            self.assertFalse(fixture['enabled'])
            self.assertEqual(len(fixture['eventDelaysMs']), 2)

    async def test_lab_scenarios_context_and_once(self):
        rule = {'id': 'scenario', 'name': 'Scenario', 'enabled': True, 'pattern': '*', 'method': '*', 'action': 'http-error-once', 'statusCode': 503}
        async with self.client.put(self.api + '/scenarios', headers=self.auth, json={'rules': [rule]}) as response:
            self.assertEqual(response.status, 200)
        async with self.client.get(self.url + '/rest', proxy=self.proxy) as response:
            self.assertEqual(response.status, 503)
        async with self.client.get(self.url + '/rest', proxy=self.proxy) as response:
            self.assertEqual(response.status, 200)
        rule['action'] = 'context-only'
        async with self.client.put(self.api + '/scenarios', headers=self.auth, json={'rules': [rule]}) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(await self.capture('/events?large=1&count=1'), b'event: context\ndata: {}\n\n')

    async def test_lab_disconnect_after_one_event(self):
        rule = {'id': 'disconnect', 'name': 'Disconnect', 'enabled': True, 'pattern': '*', 'method': '*', 'action': 'disconnect-after', 'eventCount': 1}
        async with self.client.put(self.api + '/scenarios', headers=self.auth, json={'rules': [rule]}) as response:
            self.assertEqual(response.status, 200)
        received = bytearray()
        try:
            async with self.client.get(self.url + '/events', proxy=self.proxy) as response:
                async for chunk in response.content.iter_any():
                    received.extend(chunk)
        except ClientError:
            pass
        self.assertIn(b'data: first', received)
        self.assertNotIn(b'data: second', received)
        await self.wait_for(lambda state: any(record.get('error') == 'Scenario disconnected after configured event count' for record in state['records']))

    async def test_lab_invalid_replay_and_fixture_requests(self):
        valid = {'url': self.url + '/rest', 'method': 'GET', 'headers': [], 'bodyBase64': ''}
        for value in ({}, {**valid, 'url': 'file:///tmp/ignored'}, {**valid, 'url': '/relative'},
                      {**valid, 'method': 'CONNECT'}, {**valid, 'bodyBase64': 'invalid!'},
                      {**valid, 'bodyBase64': base64.b64encode(b'x' * (8 * 1024 * 1024 + 1)).decode()}):
            async with self.client.post(self.api + '/replay', headers=self.auth, json=value) as response:
                self.assertEqual(response.status, 400, await response.text())
        await self.capture('/rest')
        state = await self.wait_for(lambda state: any(record['state'] == 'complete' for record in state['records']))
        record_id = state['records'][0]['id']
        for value in ([], None, {'timedSse': 'false'}, {'unknown': True}):
            async with self.client.post(self.api + '/records/' + record_id + '/fixture', headers=self.auth, json=value) as response:
                self.assertEqual(response.status, 400, await response.text())

    async def codec_profile(self, kind='aes-cbc'):
        profile = {'id':'loopback-codec','name':'Synthetic loopback','enabled':True,'pattern':self.url + '/rest*','kind':kind,'compression':'gzip','keyFormat':'base64','allowEditing':True}
        async with self.client.put(self.api + '/codecs', headers=self.auth, json=[profile]) as response:
            self.assertEqual(response.status, 200, await response.text())
        if kind.startswith('aes-'):
            async with self.client.post(self.api + '/codecs/loopback-codec/key', headers=self.auth, json={'key':base64.b64encode(b'0' * 16).decode()}) as response:
                self.assertEqual(response.status, 200, await response.text())
        async with self.client.put(self.api + '/rules', headers=self.auth, json=await self.rules_payload([{'id':'codec-gate','pattern':self.url + '/rest*','stages':['response'],'breakpoint':True}])) as response:
            self.assertEqual(response.status, 200, await response.text())
        return profile

    async def codec_exchange(self, wire):
        async with self.client.post(self.url + '/rest?codec=1', data=wire, proxy=self.proxy, headers={'X-Nonce':'synthetic-request-nonce'}) as response:
            return response.status, await response.text(), response.headers.get('X-Nonce')

    async def test_codec_decoded_response_edit_and_noop_reach_actual_client(self):
        from backend.codecs import transform
        for kind in ('base64', 'aes-cbc'):
            profile = await self.codec_profile(kind)
            plain = '{"context":{"nonce":"synthetic-request-nonce"},"ok":false}'
            wire = transform(profile, plain, b'0' * 16, True)
            for edited in (plain, plain.replace('false', 'true')):
                task = asyncio.create_task(self.codec_exchange(wire))
                state = await self.wait_for(lambda s: bool(s['pending']))
                gate = state['pending'][0]
                async with self.client.post(self.api + '/pending/' + gate['token'] + '/decode', headers=self.auth, json={}) as response:
                    self.assertEqual(response.status, 200, await response.text())
                    decoded = await response.json()
                    self.assertEqual(decoded['body'], plain)
                    self.assertTrue(decoded['editable'])
                # A conflicting header edit must not replace the request-bound nonce.
                value = {**gate['value'], 'headers': [[name, 'changed' if name.lower() == 'x-nonce' else val] for name, val in gate['value']['headers']]}
                async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action':'continue','value':value,'decoded':{'codecId':decoded['codecId'],'body':edited}}) as response:
                    self.assertEqual(response.status, 200, await response.text())
                status, actual, nonce = await task
                self.assertEqual(status, 200)
                self.assertEqual(nonce, 'synthetic-request-nonce')
                self.assertEqual(transform(profile, actual, b'0' * 16), edited)
                if edited == plain:
                    self.assertEqual(actual, wire)
                else:
                    self.assertNotEqual(actual, wire)
                async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action':'continue','decoded':{'codecId':decoded['codecId'],'body':edited}}) as response:
                    self.assertEqual(response.status, 409)
                await self.wait_for(lambda s: not s['pending'])

    async def test_codec_failed_encode_stays_pending_pause_preserves_wire(self):
        from backend.codecs import transform
        profile = await self.codec_profile()
        profile['compression'] = 'none'
        async with self.client.put(self.api + '/codecs', headers=self.auth, json=[profile]) as response:
            self.assertEqual(response.status, 200)
        plain = '{"ok":false}'
        wire = transform(profile, plain, b'0' * 16, True)
        task = asyncio.create_task(self.codec_exchange(wire))
        state = await self.wait_for(lambda s: bool(s['pending']))
        gate = state['pending'][0]
        # Plaintext fits the editor bound, but base64 encryption exceeds the wire bound.
        async with self.client.post(self.api + '/pending/' + gate['token'] + '/decode', headers=self.auth, json={}) as response:
            self.assertEqual(response.status, 200)
        async with self.client.post(self.api + '/pending/' + gate['token'], headers=self.auth, json={'action':'continue','decoded':{'codecId':'loopback-codec','body':'x' * (3 * 1024 * 1024 + 100)}}) as response:
            self.assertEqual(response.status, 400, await response.text())
        state = await self.state()
        self.assertEqual(state['pending'][0]['token'], gate['token'])
        self.assertFalse(task.done())
        await self.settings({'capturePaused':True})
        self.assertEqual(await task, (200, wire, 'synthetic-request-nonce'))
        self.assertFalse((await self.state())['pending'])

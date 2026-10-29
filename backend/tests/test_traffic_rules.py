"""Synthetic Map Remote, Rewrite and Block regressions; no listener or user profile."""
import base64
import tempfile
import unittest

from mitmproxy.test.tflow import tflow, tresp
from backend import traffic_rules
from backend.service import Service
from backend.traffic_tools import DEFAULT_NETWORK, validate


def base(rule_id='r', **extra):
    return {'id': rule_id, 'name': rule_id.title(), 'enabled': True, 'method': '*', 'pattern': 'https://api.example.com/*', **extra}


def remote(**extra):
    return {**base('remote'), 'scheme': 'https', 'host': 'staging.example.com', 'port': 0, 'pathFrom': '', 'pathTo': '', 'keepHost': False, 'headerOps': [], **extra}


def config(**rules):
    return {'mapLocalRules': [], 'network': dict(DEFAULT_NETWORK), **rules}


def make_flow(url='https://api.example.com/v1/users?page=2', method='GET'):
    flow = tflow(resp=False)
    flow.request.method = method
    flow.request.url = url
    flow.request.headers['Authorization'] = 'Bearer prod-token'
    flow.request.headers['Host'] = flow.request.host
    return flow


class TrafficRulesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'synthetic', 47821)

    async def asyncTearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    def use(self, **rules):
        self.service.traffic_tools = validate(config(**rules))

    def test_validation_defaults_and_rejections(self):
        value = validate({'mapLocalRules': [], 'network': dict(DEFAULT_NETWORK)})
        self.assertEqual([value[key] for key in traffic_rules.RULE_KEYS], [[], [], []])
        bad = [
            ('mapRemoteRules', remote(scheme='ftp')), ('mapRemoteRules', remote(host='bad host')),
            ('mapRemoteRules', remote(port=70000)), ('mapRemoteRules', remote(pathFrom='no-slash')),
            ('mapRemoteRules', remote(pathTo='/x')), ('mapRemoteRules', remote(headerOps=[{'op': 'set', 'name': 'Host', 'value': 'x'}])),
            ('mapRemoteRules', remote(headerOps=[{'op': 'set', 'name': 'X-A', 'value': 'a\r\nb'}])),
            ('mapRemoteRules', remote(headerOps=[{'op': 'append', 'name': 'X-A', 'value': 'a'}])),
            ('rewriteRules', base(phase='request', headerOps=[], statusCode=0, bodyFind='', bodyReplace='')),
            ('rewriteRules', base(phase='request', headerOps=[], statusCode=0, bodyFind='a', bodyReplace='b')),
            ('rewriteRules', base(phase='response', headerOps=[], statusCode=99, bodyFind='', bodyReplace='')),
            ('rewriteRules', base(phase='response', headerOps=[], statusCode=0, bodyFind='', bodyReplace='b')),
            ('blockRules', base(action='respond', statusCode=200)), ('blockRules', base(action='drop', statusCode=403)),
            ('blockRules', base(action='respond', statusCode=403, group='x' * 65)),
            ('blockRules', {**base(action='respond', statusCode=403), 'extra': 1}),
        ]
        for key, rule in bad:
            with self.assertRaises(ValueError, msg=(key, rule)):
                validate(config(**{key: [rule]}))
        with self.assertRaises(ValueError):
            validate(config(blockRules=[base(action='close', statusCode=403)] * 2))
        with self.assertRaises(ValueError):
            validate(config(blockRules=[base(str(i), action='close', statusCode=403) for i in range(101)]))

    async def test_persistence_revision_and_legacy_config(self):
        service = self.service
        service.persist_config(traffic_tools=validate(config(blockRules=[base(action='respond', statusCode=451, body='Blocked', group='Staging')])))
        self.assertEqual(service.traffic_tools_revision, 1)
        other = Service(self.directory.name, 'synthetic', 47821)
        try:
            self.assertEqual(other.traffic_tools['blockRules'][0]['statusCode'], 451)
            other.db.execute("INSERT OR REPLACE INTO config(key,value) VALUES('trafficTools',?)", ('{"mapLocalRules": [], "network": {}}',))
            other.db.commit()
        finally:
            other.db.close()
        legacy = Service(self.directory.name, 'synthetic', 47821)
        try:
            self.assertEqual(legacy.traffic_tools['mapRemoteRules'], [])
        finally:
            legacy.db.close()
        self.assertIn('blockRules', service.state()['trafficTools'])

    async def test_map_remote_rewrites_origin_preserves_path_query_and_overrides_headers(self):
        ops = [{'op': 'set', 'name': 'Authorization', 'value': 'Bearer staging-token'}, {'op': 'set', 'name': 'X-Session-Id', 'value': 'staging-session'},
               {'op': 'remove', 'name': 'Cookie'}]
        self.use(mapRemoteRules=[remote(pathFrom='/v1', pathTo='/staging/v2', headerOps=ops)])
        flow = make_flow()
        flow.request.headers['Cookie'] = 'session=prod'
        traffic_rules.map_remote(self.service, flow)
        self.assertEqual(flow.request.url, 'https://staging.example.com/staging/v2/users?page=2')
        self.assertEqual(flow.request.headers['Host'], 'staging.example.com')
        self.assertEqual(flow.request.headers['Authorization'], 'Bearer staging-token')
        self.assertEqual(flow.request.headers['X-Session-Id'], 'staging-session')
        self.assertNotIn('Cookie', flow.request.headers)
        self.assertEqual(flow.metadata['streamglass_applied_rules'][0]['type'], 'map-remote')

    async def test_map_remote_keep_host_port_scheme_and_path_boundary(self):
        self.use(mapRemoteRules=[{**remote(pathFrom='/v1', pathTo=''), 'scheme': 'http', 'port': 8080, 'keepHost': True}])
        flow = make_flow()
        flow.request.headers['Host'] = 'api.example.com'
        traffic_rules.map_remote(self.service, flow)
        self.assertEqual((flow.request.scheme, flow.request.host, flow.request.port), ('http', 'staging.example.com', 8080))
        self.assertEqual(flow.request.path, '/users?page=2')
        self.assertEqual(flow.request.headers['Host'], 'api.example.com')
        unrelated = make_flow('https://api.example.com/v10/users')
        traffic_rules.map_remote(self.service, unrelated)
        self.assertEqual(unrelated.request.path, '/v10/users')

    async def test_rules_do_not_match_or_apply_when_disabled_or_paused(self):
        self.use(mapRemoteRules=[{**remote(), 'enabled': False}], blockRules=[base(action='close', statusCode=403)])
        flow = make_flow()
        self.assertIsNone(traffic_rules.map_remote(self.service, flow))
        self.service.set_capture_paused(True)
        self.assertIsNone(traffic_rules.block_request(self.service, flow))
        self.assertFalse(traffic_rules.needs_request_buffer(self.service, flow))
        self.assertNotIn('streamglass_applied_rules', flow.metadata)

    async def test_rewrite_request_and_response_headers_status_and_body(self):
        self.use(rewriteRules=[
            base('req', phase='request', headerOps=[{'op': 'set', 'name': 'X-Env', 'value': 'qa'}], statusCode=0, bodyFind='', bodyReplace=''),
            base('resp', phase='response', headerOps=[{'op': 'remove', 'name': 'Set-Cookie'}, {'op': 'set', 'name': 'X-Rewritten', 'value': 'yes'}],
                 statusCode=503, bodyFind='prod.example.com', bodyReplace='staging.example.com')])
        flow = make_flow()
        traffic_rules.rewrite_request(self.service, flow)
        self.assertEqual(flow.request.headers['X-Env'], 'qa')
        flow.response = tresp(content=b'{"url":"prod.example.com","u2":"prod.example.com"}')
        flow.response.headers['Set-Cookie'] = 'a=b'
        flow.response.headers['Content-Type'] = 'application/json'
        flow.response.stream = False
        traffic_rules.rewrite_response_headers(self.service, flow)
        traffic_rules.rewrite_response_headers(self.service, flow)
        traffic_rules.rewrite_response_body(self.service, flow)
        self.assertEqual(flow.response.status_code, 503)
        self.assertNotIn('Set-Cookie', flow.response.headers)
        self.assertEqual(flow.response.content, b'{"url":"staging.example.com","u2":"staging.example.com"}')
        self.assertEqual(flow.response.headers['Content-Length'], str(len(flow.response.content)))
        self.assertEqual([r['id'] for r in flow.metadata['streamglass_applied_rules']].count('resp'), 2)

    async def test_body_rewrite_skips_sse_streamed_binary_and_oversized_bodies_without_truncating(self):
        self.use(rewriteRules=[base(phase='response', headerOps=[], statusCode=0, bodyFind='a', bodyReplace='b')])
        cases = {'sse': (b'data: a\n\n', 'text/event-stream', False), 'binary': (b'\xff\xfea', 'application/octet-stream', False),
                 'big': (b'a' * (traffic_rules.MAX_REWRITE_BODY + 1), 'text/plain', False), 'streamed': (b'aaa', 'text/plain', True)}
        for name, (content, kind, stream) in cases.items():
            flow = make_flow()
            flow.response = tresp(content=content)
            flow.response.headers['Content-Type'] = kind
            flow.response.stream = stream
            traffic_rules.rewrite_response_body(self.service, flow)
            self.assertEqual(flow.response.content, content, name)
            self.assertIn('not rewritten', flow.metadata['streamglass_applied_rules'][0]['detail'], name)

    async def test_body_rewrite_decodes_compressed_bodies_with_a_bound(self):
        import gzip
        self.use(rewriteRules=[base(phase='response', headerOps=[], statusCode=0, bodyFind='a', bodyReplace='b')])
        flow = make_flow()
        flow.response = tresp(content=b'')
        flow.response.headers['Content-Type'] = 'text/plain'
        flow.response.headers['Content-Encoding'] = 'gzip'
        flow.response.raw_content = gzip.compress(b'aaa')
        flow.response.stream = False
        traffic_rules.rewrite_response_body(self.service, flow)
        self.assertEqual(flow.response.content, b'bbb')
        # A small wire body that expands past the bound is forwarded unchanged instead of being decoded in full.
        bomb = gzip.compress(b'a' * (traffic_rules.MAX_REWRITE_BODY + 1024))
        self.assertLess(len(bomb), traffic_rules.MAX_REWRITE_BODY)
        flow = make_flow()
        flow.response = tresp(content=b'')
        flow.response.headers['Content-Type'] = 'text/plain'
        flow.response.headers['Content-Encoding'] = 'gzip'
        flow.response.raw_content = bomb
        flow.response.stream = False
        traffic_rules.rewrite_response_body(self.service, flow)
        self.assertEqual(flow.response.raw_content, bomb)
        self.assertEqual(flow.metadata['streamglass_applied_rules'][0]['detail'], 'decoded body over 8 MiB not rewritten')

    async def test_block_responds_without_upstream_and_has_precedence_over_map_local(self):
        local = {'id': 'local', 'name': 'Local', 'enabled': True, 'method': '*', 'pattern': '*', 'statusCode': 200, 'headers': [],
                 'bodyBase64': base64.b64encode(b'local').decode()}
        self.use(blockRules=[base(action='respond', statusCode=451, body='Blocked by policy')], mapRemoteRules=[remote()])
        self.service.traffic_tools['mapLocalRules'] = [local]
        flow = make_flow()
        await self.service.request(flow)
        self.assertEqual((flow.response.status_code, flow.response.content), (451, b'Blocked by policy'))
        self.assertEqual(flow.request.host, 'api.example.com')
        self.assertEqual(self.service.records[flow.id]['appliedRules'], [{'type': 'block', 'id': 'r', 'name': 'R', 'detail': '451'}])

    async def test_block_close_kills_flow_and_records_rule(self):
        self.use(blockRules=[base(action='close', statusCode=403)])
        flow = make_flow()
        await self.service.request(flow)
        record = self.service.records[flow.id]
        self.assertEqual(record['state'], 'error')
        self.assertIn('Block rule', record['error'])
        self.assertEqual(record['appliedRules'][0]['type'], 'block')

    async def test_map_local_precedes_remote_and_rewrite_request_and_pause_passes_through(self):
        local = {'id': 'local', 'name': 'Local', 'enabled': True, 'method': '*', 'pattern': '*', 'statusCode': 200, 'headers': [],
                 'bodyBase64': base64.b64encode(b'local').decode()}
        self.use(mapRemoteRules=[remote()], rewriteRules=[base('req', phase='request', headerOps=[{'op': 'set', 'name': 'X-Env', 'value': 'qa'}],
                                                              statusCode=0, bodyFind='', bodyReplace='')])
        self.service.traffic_tools['mapLocalRules'] = [local]
        flow = make_flow()
        await self.service.request(flow)
        self.assertEqual(flow.response.content, b'local')
        self.assertEqual(flow.request.host, 'api.example.com')
        self.assertNotIn('X-Env', flow.request.headers)
        self.service.traffic_tools['mapLocalRules'] = []
        mapped = make_flow()
        await self.service.request(mapped)
        self.assertEqual((mapped.request.host, mapped.request.headers['X-Env']), ('staging.example.com', 'qa'))
        self.assertEqual([r['type'] for r in self.service.records[mapped.id]['appliedRules']], ['map-remote', 'rewrite'])
        self.service.set_capture_paused(True)
        paused = make_flow()
        await self.service.request(paused)
        self.assertEqual(paused.request.host, 'api.example.com')
        self.assertNotIn('X-Env', paused.request.headers)

    async def test_oversized_upload_matching_block_rule_is_rejected_before_origin(self):
        self.use(blockRules=[base(action='respond', statusCode=403)])
        flow = make_flow()
        flow.request.headers['content-length'] = str(8 * 1024 * 1024 + 1)
        await self.service.requestheaders(flow)
        self.assertEqual(flow.response.status_code, 413)
        other = make_flow('https://other.example.com/x')
        other.request.headers['content-length'] = str(8 * 1024 * 1024 + 1)
        other.request.stream = True
        await self.service.requestheaders(other)
        self.assertIsNone(other.response)
        self.assertTrue(other.request.stream)


if __name__ == '__main__':
    unittest.main()

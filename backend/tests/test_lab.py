import base64
import tempfile
import unittest
from types import SimpleNamespace
from mitmproxy.test.tflow import tflow
from backend.lab import validate_scenarios, on_request, on_event
from backend.service import Service


class LabTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'token', 47821)
        self.flow = tflow()

    async def asyncTearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    def rule(self, action):
        return dict(id='one', name='One', pattern='*', method='*', enabled=True, action=action)

    async def test_once_then_upstream_and_reset_on_reload(self):
        self.service.scenarios = validate_scenarios({'rules': [self.rule('http-error-once')]})
        on_request(self.service, self.flow)
        self.assertEqual(self.flow.response.status_code, 503)
        second = tflow()
        on_request(self.service, second)
        self.assertIsNone(second.response)
        self.service.persist_config()
        restored = Service(self.directory.name, 'token', 47821)
        try:
            self.assertEqual(restored.scenarios, self.service.scenarios)
        finally:
            restored.db.close()

    async def test_context_and_pause(self):
        self.service.scenarios = validate_scenarios({'rules': [self.rule('context-only')]})
        on_request(self.service, self.flow)
        self.assertFalse(await on_event(self.service, self.flow, {'sequence': 1, 'event': 'data'}))
        self.assertTrue(await on_event(self.service, self.flow, {'sequence': 2, 'event': 'context'}))
        self.service.set_capture_paused(True)
        self.assertTrue(await on_event(self.service, self.flow, {'sequence': 3, 'event': 'data'}))

    def test_validation(self):
        for field, value in [('enabled', 1), ('delayMs', -1), ('eventCount', True), ('statusCode', 200), ('action', 'unknown')]:
            rule = self.rule('context-only')
            rule[field] = value
            with self.assertRaises(ValueError):
                validate_scenarios({'rules': [rule]})

    def test_fixture_validation_and_complete_event_count(self):
        from backend.lab import make_fixture
        record = dict(kind='request', state='complete', url='http://example.test/events', method='GET', isSSE=True,
                      eventCount=1, events=[{'raw': 'data: edited\n\n', 'receivedAt': 1}],
                      response={'statusCode': 200, 'headers': [['Content-Type', 'text/event-stream']], 'bodyUnavailable': True})
        for value in ([], None, {'timedSse': 'false'}, {'unknown': True}):
            with self.assertRaises(ValueError):
                make_fixture(record, value)
        self.assertEqual(base64.b64decode(make_fixture(record, {})['bodyBase64']), b'data: edited\n\n')
        record['eventCount'] = 2
        with self.assertRaises(ValueError):
            make_fixture(record, {})
        record['eventCount'] = 1
        record['sseDiagnostics'] = {'eventCount': 2}
        with self.assertRaises(ValueError):
            make_fixture(record, {})
        record.pop('sseDiagnostics')
        record['events'][0].pop('raw')
        with self.assertRaises(ValueError):
            make_fixture(record, {})

    def test_fixture_requires_body_and_preserves_encoding(self):
        from backend.lab import make_fixture
        record = dict(state='complete', url='http://example.test/', method='GET', response={'statusCode': 200, 'headers': [['Content-Encoding', 'gzip']]})
        with self.assertRaises(ValueError):
            make_fixture(record, {})
        record['response']['bodyBase64'] = base64.b64encode(b'compressed').decode()
        self.assertEqual(make_fixture(record, {})['headers'], [['Content-Encoding', 'gzip']])

    def test_timed_fixture_does_not_silently_shorten_long_gap(self):
        from backend.lab import make_fixture
        record = dict(state='complete', url='http://example.test/', method='GET', isSSE=True, eventCount=1,
                      sseDiagnostics={'headersAt': 0, 'eventCount': 1},
                      events=[{'raw': 'data: later\n\n', 'receivedAt': 61}],
                      response={'statusCode': 200, 'headers': []})
        with self.assertRaisesRegex(ValueError, '60 second'):
            make_fixture(record, {'timedSse': True})

    async def test_fixture_uses_transmitted_edited_event_bytes(self):
        from backend.lab import make_fixture
        service, flow = self.service, self.flow
        service.records[flow.id] = dict(id=flow.id, startedAt=0, state='streaming', events=[], eventCount=0)
        service.streams[flow.id] = {'bytes': 0}
        async def edit(flow, stage, value):
            return {**value, 'data': 'edited'}
        service.process = edit
        hook = SimpleNamespace(flow=flow, event={'_bytes': b'data: original\n\n', 'data': 'original', 'sequence': 1, 'event': 'message'}, output=[])
        await service.streamglass_sseevent(hook)
        record = service.records[flow.id]
        record.update(state='complete', method='GET', url='http://example.test/', isSSE=True,
                      response={'statusCode': 200, 'headers': []})
        self.assertEqual(base64.b64decode(make_fixture(record, {})['bodyBase64']), b''.join(hook.output))
        self.assertIn(b'edited', b''.join(hook.output))
        self.assertEqual(record['sseDiagnostics']['eventBytes'], len(b'data: original\n\n'))

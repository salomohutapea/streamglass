import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from mitmproxy import http

from backend.api import create_app
from backend.search import search
from backend.service import Service


class SearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'test-token', 47821)
        self.service.save({'id': 'one', 'startedAt': 100, 'state': 'pending', 'url': 'https://example.test/search/sse',
                           'request': {'headers': [['X-Request', 'request-header']], 'body': 'Straße request-body', 'bodyBase64': 'hidden-base64'},
                           'response': {'headers': [['X-Response', 'response-header']], 'body': 'response-body', 'statusCode': 201},
                           'events': [{'event': 'delta', 'data': 'event-data', 'id': 'event-id', 'retry': 321}], 'eventCount': 1})
        self.service.save({'id': 'opaque', 'startedAt': 101, 'state': 'pending', 'url': 'opaque.test:443', 'events': []})

    async def asyncTearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    async def test_scopes_only_search_their_contents(self):
        for scope, queries in [('url', ['search/sse']), ('request', ['request-header', 'request-body', 'STRASSE']),
                               ('response', ['response-header', 'response-body', '201']),
                               ('event', ['delta', 'event-data', 'event-id', '321'])]:
            for query in queries:
                self.assertEqual((await search(self.service, scope, query))['ids'], ['one'])
        for scope, query in [('response', 'request-body'), ('request', 'response-body'), ('event', 'response-body'),
                             ('response', 'event-data'), ('request', 'hidden-base64'), ('event', 'eventCount')]:
            self.assertEqual((await search(self.service, scope, query))['ids'], [])

    async def test_modes_and_missing_contents(self):
        for mode, query in [('contains', 'SEARCH/SSE'), ('equals', 'https://example.test/search/sse'),
                            ('starts_with', 'https://'), ('ends_with', '/SSE'), ('wildcard', '*EXAMPLE.TEST/*/ss?')]:
            self.assertEqual((await search(self.service, 'url', query, mode))['ids'], ['one'])
        self.assertEqual((await search(self.service, 'response', 'absent', 'not_contains'))['ids'], ['one'])
        self.assertEqual((await search(self.service, 'request', '.*'))['ids'], [])
        self.assertEqual(set((await search(self.service, 'event', ''))['ids']), {'one', 'opaque'})

    async def test_unretained_body_warns_and_cannot_match_negative(self):
        self.service.records['one']['response'].update(bodyUnavailable=True, bodyPreview='retained-preview')
        self.service.changed()
        result = await search(self.service, 'response', 'retained-preview')
        self.assertEqual(result['ids'], ['one'])
        self.assertTrue(result['incomplete'])
        self.assertTrue(result['warning'])
        self.assertEqual((await search(self.service, 'response', 'absent', 'not_contains'))['ids'], [])
        self.assertEqual(set(result), {'ids', 'incomplete', 'warning'})

    async def test_cache_invalidates_after_capture_changes(self):
        self.assertEqual((await search(self.service, 'event', 'new-event'))['ids'], [])
        self.service.records['one']['events'].append({'data': 'new-event'})
        self.service.changed()
        self.assertEqual((await search(self.service, 'event', 'new-event'))['ids'], ['one'])

    async def test_polling_rechecks_only_changed_captures(self):
        import backend.search as module
        checked = []
        original = module.evaluate_each
        def counting(records, *args):
            checked.append(sorted(record["id"] for record in records))
            return original(records, *args)
        with patch.object(module, "evaluate_each", counting):
            first = await search(self.service, 'url', 'example')
            self.service.changed()
            self.assertEqual(await search(self.service, 'url', 'example'), first)
            record = self.service.records['one']
            self.service.save({**record, 'url': record['url'] + '?changed'})
            await search(self.service, 'url', 'example')
        self.assertEqual(checked[1:], [['one']])

    async def test_api_validates_search_inputs(self):
        client = TestClient(TestServer(create_app(self.service)))
        await client.start_server()
        try:
            headers = {'Authorization': 'Bearer test-token', 'Host': '127.0.0.1:47821'}
            response = await client.get('/api/search', params={'q': 'search/sse'}, headers=headers)
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['ids'], ['one'])
            for params in ({'scope': 'other'}, {'mode': 'regex'}, {'q': 'x' * 1025}):
                response = await client.get('/api/search', params=params, headers=headers)
                self.assertEqual(response.status, 400)
        finally:
            await client.close()

    async def test_zero_event_sse_and_legacy_summary(self):
        record = self.service.records['opaque']
        record['response'] = {'headers': [['Content-Type', 'Text/Event-Stream; charset=utf-8']]}
        summary = next(row for row in self.service.state()['records'] if row['id'] == 'opaque')
        self.assertTrue(summary['isSSE'])
        flow = SimpleNamespace(id='opaque', response=http.Response.make(200, b'', {'Content-Type': 'text/event-stream'}),
                               request=SimpleNamespace(method='GET'), metadata={})
        await self.service.responseheaders(flow)
        self.assertTrue(self.service.records['opaque']['isSSE'])
        self.assertEqual(self.service.records['opaque'].get('eventCount', 0), 0)

    async def test_duration_tracks_terminal_time_and_stays_fixed(self):
        for state in ('complete', 'error'):
            record = {'id': state, 'startedAt': 100, 'state': state, 'kind': 'tunnel'}
            with patch('backend.service.time.time', return_value=102.5):
                self.service.save(record)
            with patch('backend.service.time.time', return_value=150):
                self.service.save(record)
            self.assertEqual(record['endedAt'], 102.5)
            self.assertEqual(record['durationMs'], 2500)

"""Application attribution is optional background metadata, never a traffic gate."""
import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch

from mitmproxy.test.tflow import tflow
from backend.service import Service, MAX_RECORDS


APP = {'id': 'app:42', 'name': 'SampleApp', 'pid': 42, 'bundleId': 'com.example.sampleapp',
       'kind': 'application', 'platform': 'iosSimulator'}


class ApplicationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'application-token', 47821)
        self.release = asyncio.Event()
        self.calls = []
        self.result = {'clientIsLocal': True, 'application': APP}
        self.status = 200
        self.error = None
        owner = self

        class Response:
            async def __aenter__(self):
                if owner.error:
                    raise owner.error
                self.status = owner.status
                self.content = self
                return self

            async def __aexit__(self, *args):
                pass

            async def readexactly(self, limit):
                await owner.release.wait()
                raise asyncio.IncompleteReadError(json.dumps(owner.result).encode(), limit)

        class Session:
            def __init__(self, *, timeout):
                owner.assertLessEqual(timeout.total, 12)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def post(self, url, **kwargs):
                owner.calls.append((url, kwargs))
                return Response()

        self.environment = patch.dict('os.environ', STREAMGLASS_SCRIPT_URL='http://127.0.0.1:1234')
        self.environment.start()
        self.session = patch('backend.service.ClientSession', Session)
        self.session.start()

    async def asyncTearDown(self):
        tasks = [entry['task'] for entry in self.service.applications.values() if entry['task']]
        self.service.done()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.session.stop()
        self.environment.stop()
        self.service.db.close()
        self.directory.cleanup()

    def flow(self, client=None):
        flow = tflow()
        if client is not None:
            flow.client_conn = client
        flow.client_conn.peername = ('127.0.0.1', 52123)
        return flow

    async def finish(self, client):
        task = self.service.applications[client.id]['task']
        self.release.set()
        if task:
            await task

    async def test_delayed_lookup_does_not_block_rules_or_completed_request(self):
        flow = self.flow()
        self.service.client_connected(flow.client_conn)
        rules_called = []
        async def rules(flow, stage, value):
            rules_called.append(stage)
            return value
        with patch.object(self.service, 'process', rules):
            await asyncio.wait_for(self.service.request(flow), .2)
        self.assertEqual(rules_called, ['request'])
        self.assertIsNone(self.service.records[flow.id]['application'])
        self.service.records[flow.id]['state'] = 'complete'
        self.service.save(self.service.records[flow.id])
        self.service.client_disconnected(flow.client_conn)
        await self.finish(flow.client_conn)
        self.assertEqual(self.service.records[flow.id]['application'], APP)
        self.assertTrue(self.service.state()['records'][0]['clientIsLocal'])
        self.assertNotIn(flow.client_conn.id, self.service.applications)
        url, options = self.calls[0]
        self.assertEqual(url, 'http://127.0.0.1:1234/application')
        self.assertEqual(options['json'], {'clientHost': '127.0.0.1', 'clientPort': 52123, 'proxyPort': 8080})
        self.assertEqual(options['headers'], {'Authorization': 'Bearer application-token'})

    async def test_connect_and_subsequent_http_share_single_connection_lookup(self):
        tunnel = self.flow()
        self.service.client_connected(tunnel.client_conn)
        self.service.http_connect(tunnel)
        await self.finish(tunnel.client_conn)
        self.assertEqual(self.service.records[tunnel.id]['application'], APP)
        request = self.flow(tunnel.client_conn)
        await self.service.request(request)
        self.assertNotIn(tunnel.id, self.service.records)
        self.assertEqual(self.service.records[request.id]['application'], APP)
        self.assertEqual(len(self.calls), 1)
        self.service.client_disconnected(request.client_conn)
        self.assertNotIn(request.client_conn.id, self.service.applications)

    async def test_delayed_opaque_connect_updates_completed_tunnel_on_disk(self):
        tunnel = self.flow()
        self.service.client_connected(tunnel.client_conn)
        self.service.http_connect(tunnel)
        self.service.client_disconnected(tunnel.client_conn)
        self.assertEqual(self.service.records[tunnel.id]['state'], 'complete')
        self.assertIsNone(self.service.records[tunnel.id]['application'])
        await self.finish(tunnel.client_conn)
        persisted = json.loads(self.service.db.execute('SELECT payload FROM records WHERE id=?', (tunnel.id,)).fetchone()[0])
        self.assertEqual(persisted['application'], APP)
        self.assertTrue(persisted['clientIsLocal'])
        self.assertNotIn(tunnel.client_conn.id, self.service.applications)

    async def test_delayed_connect_and_multiple_http_records_receive_metadata(self):
        tunnel = self.flow()
        self.service.client_connected(tunnel.client_conn)
        self.service.http_connect(tunnel)
        request = self.flow(tunnel.client_conn)
        await self.service.request(request)
        second = self.flow(tunnel.client_conn)
        await self.service.request(second)
        await self.finish(tunnel.client_conn)
        self.assertEqual(self.service.records[request.id]['application'], APP)
        self.assertEqual(self.service.records[second.id]['application'], APP)
        self.assertEqual(len(self.calls), 1)

    async def test_port_reuse_does_not_inherit_application(self):
        first, second = self.flow(), self.flow()
        self.assertNotEqual(first.client_conn.id, second.client_conn.id)
        self.service.client_connected(first.client_conn)
        await self.finish(first.client_conn)
        await self.service.request(first)
        self.service.client_disconnected(first.client_conn)
        self.release.clear()
        self.result = {'clientIsLocal': True, 'application': None}
        self.service.client_connected(second.client_conn)
        await self.service.request(second)
        await self.finish(second.client_conn)
        self.assertIsNone(self.service.records[second.id]['application'])
        self.assertEqual(self.service.records[first.id]['application'], APP)

    async def test_failure_remains_unknown_without_traffic_error(self):
        for error in (OSError('unavailable'), TimeoutError('slow')):
            flow = self.flow()
            self.error = error
            self.service.client_connected(flow.client_conn)
            await self.service.request(flow)
            self.service.client_disconnected(flow.client_conn)
            await self.finish(flow.client_conn)
            self.assertIsNone(self.service.records[flow.id]['application'])
            self.assertIsNone(self.service.records[flow.id]['clientIsLocal'])
            self.assertNotIn('error', self.service.records[flow.id])
            self.assertNotIn(flow.client_conn.id, self.service.applications)

    async def test_paused_connections_do_not_start_lookup(self):
        self.service.settings['capturePaused'] = True
        self.service.client_connected(self.flow().client_conn)
        self.assertEqual(self.service.applications, {})
        self.assertEqual(self.calls, [])

    async def test_shutdown_cancels_and_clears_pending_lookup(self):
        flow = self.flow()
        self.service.client_connected(flow.client_conn)
        task = self.service.applications[flow.client_conn.id]['task']
        await asyncio.sleep(0)
        self.service.done()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertEqual(self.service.applications, {})

    async def test_lookup_concurrency_and_tracking_are_bounded(self):
        for _ in range(30):
            self.service.client_connected(self.flow().client_conn)
        self.assertEqual(len(self.service.applications), 16)
        entry = next(iter(self.service.applications.values()))
        self.assertIsNotNone(entry['task'])
        self.assertLessEqual(len(entry['records']), MAX_RECORDS)


class ApplicationValidationTests(unittest.TestCase):
    def test_invalid_metadata_preserves_known_locality(self):
        for field, value in [('id', ''), ('name', 'a' * 257), ('pid', True), ('pid', -1),
                             ('icon', 'https://example.com/icon.png'), ('icon', 'data:image/svg+xml;base64,PHN2Zz4='),
                             ('icon', 'data:image/png;base64,bm90LXBuZw==')]:
            result = Service.application_value({'clientIsLocal': True, 'application': {**APP, field: value}})
            self.assertEqual(result, {'clientIsLocal': True, 'application': None})

    def test_remote_and_unknown_clients_cannot_claim_local_application(self):
        for local in (False, None, 1, 'true'):
            self.assertIsNone(Service.application_value({'clientIsLocal': local, 'application': APP})['application'])

    def test_no_user_agent_inference_and_unknown_fields_are_not_persisted(self):
        self.assertEqual(Service.application_value({'clientIsLocal': True, 'application': {**APP, 'secret': 'omit'}}),
                         {'clientIsLocal': True, 'application': APP})

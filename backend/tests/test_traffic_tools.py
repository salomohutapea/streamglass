"""Synthetic traffic-tool regressions; no listener or user profile."""
import asyncio
import base64
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mitmproxy.test.tflow import tflow
from backend.service import Service
from backend.traffic_tools import DEFAULT_NETWORK, map_response, validate


def config():
    return {'mapLocalRules': [{'id': 'fixture', 'name': 'Fixture', 'enabled': True,
                              'method': 'GET', 'pattern': '*', 'statusCode': 201,
                              'headers': [['Content-Type', 'text/plain']],
                              'bodyBase64': base64.b64encode(b'local\x00bytes').decode()}],
            'network': dict(DEFAULT_NETWORK)}


class TrafficToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'synthetic', 47821)

    async def asyncTearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    async def test_map_first_match_pause_and_persistence(self):
        service, flow = self.service, tflow()
        flow.request.method = 'GET'
        service.traffic_tools = validate(config())
        service.persist_config()
        map_response(service, flow)
        self.assertEqual(flow.response.status_code, 201)
        self.assertEqual(flow.response.content, b'local\x00bytes')
        self.assertNotIn('bodyBase64', service.state()['trafficTools']['mapLocalRules'][0])
        other = Service(self.directory.name, 'synthetic', 47821)
        try:
            self.assertEqual(other.traffic_tools, service.traffic_tools)
        finally:
            other.db.close()
        service.set_capture_paused(True)
        paused = tflow()
        map_response(service, paused)
        self.assertIsNone(paused.response)

    async def test_pause_cancels_delay_and_keeps_flow_passthrough(self):
        service, flow = self.service, tflow()
        service.traffic_tools['network'].update(enabled=True, downloadKbps=1)
        hook = SimpleNamespace(flow=flow, size=16000, upload=False)
        task = asyncio.create_task(service.streamglass_transfer(hook))
        await asyncio.sleep(0)
        service.set_capture_paused(True)
        service.set_capture_paused(False)
        await asyncio.wait_for(task, 1)
        self.assertTrue(flow.metadata['streamglass_passthrough'])

    async def test_pin_survives_automatic_eviction_and_restart(self):
        service = self.service
        with patch('backend.service.MAX_RECORDS', 2):
            for index in range(4):
                service.save({'id': str(index), 'startedAt': index, 'state': 'pending', 'pinned': index == 0})
            self.assertEqual(set(service.records), {'0', '3'})
        other = Service(self.directory.name, 'synthetic', 47821)
        try:
            self.assertTrue(other.records['0']['pinned'])
        finally:
            other.db.close()

    def test_invalid_input_rejected(self):
        for key, value in [('statusCode', True), ('bodyBase64', 'invalid!'), ('headers', [['X-Test', 'bad\r\nvalue']])]:
            data = config()
            data['mapLocalRules'][0][key] = value
            with self.assertRaises((ValueError, TypeError)):
                validate(data)
        data = config()
        data['network']['delayMs'] = -1
        with self.assertRaises(ValueError):
            validate(data)

    async def test_oversized_map_upload_rejected_before_origin(self):
        service, flow = self.service, tflow()
        service.traffic_tools = validate(config())
        flow.request.headers['content-length'] = str(8 * 1024 * 1024 + 1)
        flow.request.stream = True
        await service.requestheaders(flow)
        self.assertFalse(flow.request.stream)
        self.assertEqual(flow.response.status_code, 413)
        self.assertIn('no upstream request was sent', service.records[flow.id]['error'])
        self.assertFalse(flow.server_conn.connected)

    async def test_pause_at_local_response_gate_discards_map_before_send(self):
        service, flow = self.service, tflow()
        service.traffic_tools = validate(config())
        flow.request.method = 'GET'
        await service.request(flow)
        service.rules = [{'id': 'gate', 'enabled': True, 'stages': ['response'], 'pattern': '*', 'breakpoint': True}]
        task = asyncio.create_task(service.response(flow))
        for _ in range(30):
            if service.pending:
                break
            await asyncio.sleep(0)
        self.assertTrue(service.pending)
        service.set_capture_paused(True)
        await asyncio.wait_for(task, 1)
        self.assertIsNone(flow.response)
        self.assertNotIn('streamglass_map_local', flow.metadata)

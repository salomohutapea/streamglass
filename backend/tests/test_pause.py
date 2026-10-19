"""Pause cancels inspection work without changing messages or SSE bytes."""
import asyncio
import copy
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mitmproxy import http
from mitmproxy.test.tflow import tflow
from backend.service import Service


class PauseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name, 'pause-test-token', 47821)
        self.flow = tflow(resp=True)

    async def asyncTearDown(self):
        self.service.db.close()
        self.directory.cleanup()

    async def test_paused_requests_and_responses_keep_message_state(self):
        service, flow = self.service, self.flow
        service.rules = [{'id': 'all', 'pattern': '*', 'stages': ['request', 'response', 'event'],
                          'script': 'must never execute', 'breakpoint': True}]
        flow.request.headers['Transfer-Encoding'] = 'chunked'
        flow.response = http.Response.make(200, b'opaque\x00\xff', {'Content-Type': 'text/event-stream', 'Content-Encoding': 'custom'})
        request, response = copy.deepcopy(flow.request.data), copy.deepcopy(flow.response.data)
        service.set_capture_paused(True)
        with patch('backend.service.apply_message') as apply:
            await service.request(flow)
            service.set_capture_paused(False)
            await service.responseheaders(flow)
            await service.response(flow)
            apply.assert_not_called()
        self.assertEqual(flow.request.data, request)
        self.assertEqual(flow.response.data, response)
        self.assertTrue(flow.response.stream)
        self.assertEqual(service.records, {})
        self.assertEqual(service.pending, {})

    async def test_pause_releases_every_gate_with_original_before_scripts(self):
        service, flow = self.service, self.flow
        service.rules = [{'id': 'gate', 'pattern': '*', 'stages': ['request', 'response', 'event'], 'breakpoint': True}]
        for stage in ('request', 'response', 'event'):
            service.set_capture_paused(False)
            original = {'body': 'original', 'headers': [['X-Test', 'original']]}
            async def edit_then_gate(flow, stage, value, matches, saved, epoch):
                value['body'] = 'script edit'
                value['headers'][0][1] = 'nested script edit'
                return await Service.process_rules(service, flow, stage, value, matches, saved, epoch)
            with patch.object(service, 'process_rules', side_effect=edit_then_gate):
                task = asyncio.create_task(service.process(flow, stage, copy.deepcopy(original)))
                for _ in range(20):
                    if service.pending:
                        break
                    await asyncio.sleep(0)
                self.assertTrue(service.pending)
                self.assertEqual(service.state()['pending'][0]['value']['body'], 'script edit')
                self.assertNotIn('original', service.state()['pending'][0])
                service.set_capture_paused(True)
                service.set_capture_paused(False)
                self.assertEqual(await asyncio.wait_for(task, 1), original)
            self.assertEqual(service.pending, {})

    async def test_pause_discards_late_script_even_after_resume(self):
        service, flow = self.service, self.flow
        service.rules = [{'id': 'script', 'pattern': '*', 'stages': ['request'], 'script': 'edit'}]
        started = asyncio.Event()
        async def slow_script(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return {'body': 'late script edit'}
        with patch.object(service, 'process_rules', side_effect=slow_script):
            task = asyncio.create_task(service.process(flow, 'request', {'body': 'original'}))
            await started.wait()
            service.set_capture_paused(True)
            service.set_capture_paused(False)
            self.assertEqual(await asyncio.wait_for(task, 1), {'body': 'original'})

    async def test_pause_existing_sse_flushes_partial_frame_without_parsing_more(self):
        service, flow = self.service, self.flow
        flow.response = http.Response.make(200, b'', {'Content-Type': 'text/event-stream'})
        await service.responseheaders(flow)
        async def chunk(data):
            hook = SimpleNamespace(flow=flow, data=data, end=False, chunks=[])
            await service.streamglass_responsechunk(hook)
            return hook.chunks
        self.assertEqual(await chunk(b'data: par'), [])
        service.set_capture_paused(True)
        self.assertEqual(b''.join(await chunk(b'tial\r\n\r\n: raw\r\n\r\n')), b'data: partial\r\n\r\n: raw\r\n\r\n')
        service.set_capture_paused(False)
        self.assertEqual(await chunk(b'data: remains raw\n\n'), [b'data: remains raw\n\n'])

    async def test_unchanged_active_http_hooks_do_not_roundtrip_messages(self):
        flow = self.flow
        with patch('backend.service.apply_message') as apply:
            await self.service.request(flow)
            await self.service.responseheaders(flow)
            await self.service.response(flow)
            apply.assert_not_called()

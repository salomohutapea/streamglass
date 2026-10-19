"""Integration regression: requires pinned mitmproxy, never starts a listener."""
import inspect
import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import Mock
from backend.engine import patch_engine


class EngineTests(unittest.TestCase):
    def test_patch_installs_async_event_hooks_without_editing_dependency(self):
        from mitmproxy.proxy.layers import http
        original = http.HttpStream.state_stream_response_body
        original_handler = http.HttpStream.handle_event
        original_start_stream = http.HttpStream.start_response_stream
        try:
            patch_engine(lambda flow_id, reason: None)
            self.assertIsNot(original, http.HttpStream.state_stream_response_body)
            self.assertEqual(http.HttpSseEventHook.name, 'streamglass_sseevent')
            for hook in (http.HttpSseEventHook(object(), {}, []), http.HttpResponseChunkHook(object(), b'', False, [])):
                self.assertEqual(hook.args(), [hook])
            self.assertIn('HttpSseEventHook', http.HttpStream.state_stream_response_body.__wrapped__.__code__.co_names)
        finally:
            http.HttpStream.state_stream_response_body = original
            http.HttpStream.handle_event = original_handler
            http.HttpStream.start_response_stream = original_start_stream

    def test_queue_limit_counts_current_queue_instead_of_drained_bytes(self):
        from mitmproxy.proxy.layers import http
        original = http.HttpStream.state_stream_response_body
        original_handler = http.HttpStream.handle_event
        original_start_stream = http.HttpStream.start_response_stream
        received = []
        def handler(stream, event):
            received.append(event)
            yield from ()
        try:
            http.HttpStream.handle_event = handler
            cancelled = Mock()
            patch_engine(cancelled)
            stream = SimpleNamespace(_paused=True, _paused_event_queue=deque(),
                                     _streamglass_queued=9 * 1024 * 1024, flow=SimpleNamespace(id='test', kill=Mock()))
            event = SimpleNamespace(data=b'x')
            list(http.HttpStream.handle_event(stream, event))
            self.assertEqual(received, [event])
            stream.flow.kill.assert_not_called()
            cancelled.assert_not_called()
        finally:
            http.HttpStream.state_stream_response_body = original
            http.HttpStream.handle_event = original_handler
            http.HttpStream.start_response_stream = original_start_stream

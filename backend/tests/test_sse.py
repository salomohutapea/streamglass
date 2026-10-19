import unittest
from backend.sse import MAX_EVENT, EventTooLarge, SSEParser, serialize


class SSETests(unittest.TestCase):
    def test_split_utf8_crlf_and_multiple_events(self):
        parser = SSEParser()
        wire = 'event: change\r\ndata: hé\r\ndata: two\r\n\r\ndata: next\n\n'.encode()
        events = []
        for byte in wire:
            events.extend(parser.feed(bytes([byte])))
        self.assertEqual([event['data'] for event in events], ['hé\ntwo', 'next'])
        self.assertEqual(events[0]['event'], 'change')
        self.assertEqual(b''.join(event['_bytes'] for event in events), wire)

    def test_bom_comments_and_invalid_fields_keep_original_frames(self):
        wire = (b'\xef\xbb\xbf: heartbeat\r\n\r\n'
                b'id: safe\r\nid: bad\x00id\r\nretry: -1\r\nretry: 250\r\n'
                b'data: payload\r\n\r\n')
        parser = SSEParser()
        events = []
        for byte in wire:
            events.extend(parser.feed(bytes([byte])))
        self.assertEqual(len(events), 2)
        self.assertFalse(events[0]['dispatch'])
        self.assertTrue(events[1]['dispatch'])
        self.assertEqual(events[1]['id'], 'safe')
        self.assertEqual(events[1]['retry'], 250)
        self.assertEqual(events[1]['data'], 'payload')
        self.assertEqual(b''.join(event['_bytes'] for event in events), wire)

    def test_incomplete_final_line_remains_unforwarded_metadata(self):
        wire = b'data: complete\n\ndata: unfinished\r'
        parser = SSEParser()
        events = parser.feed(wire, end=True)
        self.assertEqual([event['dispatch'] for event in events], [True, False])
        self.assertEqual(b''.join(event['_bytes'] for event in events), wire)

    def test_incomplete_eof_does_not_dispatch(self):
        parser = SSEParser()
        events = parser.feed(b'data: unfinished', end=True)
        self.assertFalse(events[0]['dispatch'])

    def test_edit_roundtrip(self):
        result = SSEParser().feed(serialize({'event': 'edited', 'data': 'a\nb', 'id': '7', 'retry': 10}))
        self.assertEqual(result[0]['event'], 'edited')
        self.assertEqual(result[0]['data'], 'a\nb')
        self.assertEqual(result[0]['id'], '7')

    def test_huge_retry_is_opaque_metadata_and_does_not_break_forwarding(self):
        wire = b'retry: ' + b'9' * 10000 + b'\ndata: still delivered\n\n'
        event = SSEParser().feed(wire)[0]
        self.assertIsNone(event['retry'])
        self.assertEqual(event['data'], 'still delivered')
        self.assertEqual(event['_bytes'], wire)
        event = SSEParser().feed(b'retry: ' + b'0' * 10000 + b'10\ndata: ok\n\n')[0]
        self.assertEqual(event['retry'], 10)

    def test_injection_rejected(self):
        with self.assertRaises(ValueError):
            serialize({'event': 'bad\ndata: injected'})

    def test_oversized_event_rejected(self):
        with self.assertRaises(ValueError):
            SSEParser().feed(b'x' * (MAX_EVENT + 1))

    def test_oversized_fallback_preserves_completed_events_and_buffer(self):
        wire = b'event: context\ndata: {}\n\n' + b'data: ' + b'x' * (MAX_EVENT + 1) + b'\n\n'
        with self.assertRaises(EventTooLarge) as raised:
            SSEParser().feed(wire)
        failure = raised.exception
        self.assertEqual(len(failure.events), 1)
        self.assertEqual(b''.join(event['_bytes'] for event in failure.events) + failure.raw, wire)

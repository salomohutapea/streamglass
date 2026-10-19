import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from mitmproxy import http
from backend.service import Service, apply_message, message_value, device_platform, SSL_INTERRUPTION_REASON


class MessageTests(unittest.TestCase):
    def test_device_platform_uses_evidence_not_ip(self):
        for agent, expected in [("Mozilla Android 16", "android"), ("iPhone; CPU iPhone OS like Mac OS X", "ios"), ("iPad; CPU OS like Mac OS X", "ios"), ("Mozilla Macintosh; Intel Mac OS X", "mac"), ("App CFNetwork/1 Darwin/25", None), ("okhttp/4", None)]:
            self.assertEqual(device_platform({"request": {"headers": [["User-Agent", agent]]}}), expected)
        self.assertIsNone(device_platform({"device": "127.0.0.1"}))

    def test_duplicate_headers_and_status_edit(self):
        response = http.Response.make(200, b'original')
        value = message_value(response)
        value.update(statusCode=201, headers=[['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']], body='changed')
        apply_message(response, value)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.content, b'changed')
        self.assertEqual(response.headers.get_all('set-cookie'), ['a=1', 'b=2'])

    def test_header_injection_rejected_before_mutation(self):
        response = http.Response.make(200, b'original')
        value = message_value(response)
        value['headers'] = [['X-Test', 'bad\r\ninjected: yes']]
        with self.assertRaises(ValueError):
            apply_message(response, value)
        self.assertEqual(response.content, b'original')

    def test_status_edit_preserves_binary_body(self):
        response = http.Response.make(200, b'\x00\xff\x01')
        value = message_value(response)
        value['statusCode'] = 503
        apply_message(response, value)
        self.assertEqual(response.raw_content, b'\x00\xff\x01')

    def test_no_content_status_removes_body_and_length(self):
        response = http.Response.make(200, b'original')
        value = message_value(response)
        value['statusCode'] = 204
        apply_message(response, value)
        self.assertEqual(response.raw_content, b'')
        self.assertNotIn('content-length', response.headers)

    def test_empty_tls_allowlist_matches_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, 'a' * 32, 47821)
            self.assertEqual(service.tls_patterns(), ['(?!)'])
            service.db.close()

    def test_tunnel_reset_uses_same_patterns_and_cleans_up_live_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, 'a' * 32, 47821)
            service.settings['capturePaused'] = True
            connections = {}
            service.master = SimpleNamespace(addons=SimpleNamespace(get=lambda _: SimpleNamespace(connections=connections)))
            def tunnel(host, port=443, inspected=False):
                # Connection objects are identity-hashable in mitmproxy.
                client = Mock(id=host, tls=inspected, sni=None)
                flow = SimpleNamespace(id=host, client_conn=client, request=SimpleNamespace(host=host, port=port),
                                       server_conn=SimpleNamespace(address=(host, port), peername=None))
                handler = Mock(client=client, transports={client: SimpleNamespace(handler=Mock())})
                connections[host] = handler
                service.http_connect(flow)
                return flow, handler
            matched, reset = tunnel('API.Example.com', 8443)
            _, existing = tunnel('old.example.com')
            _, inspected = tunnel('inspected.example.com', inspected=True)
            other, unrelated = tunnel('unrelated.test')
            _, wrong_port = tunnel('api.example.com', 443)
            service.settings['tlsDomains'] = ['*.example.com:8443', 'old.example.com', 'inspected.example.com']
            self.assertEqual(service.interrupt_newly_inspected_tunnels(['old.example.com']), 1)
            reset.close_connection.assert_called_once_with(matched.client_conn)
            for handler in (existing, inspected, unrelated, wrong_port):
                handler.close_connection.assert_not_called()
            self.assertNotIn(matched.client_conn.id, service.active_tunnels)
            self.assertEqual(service.records, {})
            service.client_disconnected(other.client_conn)
            self.assertNotIn(other.client_conn.id, service.active_tunnels)
            service.done()
            self.assertEqual(service.active_tunnels, {})
            service.db.close()

    def test_unchanged_websocket_upgrade_keeps_handshake_headers(self):
        response = http.Response.make(101, b'', {'Upgrade': 'websocket', 'Connection': 'Upgrade'})
        response.headers.pop('content-length', None)
        apply_message(response, message_value(response))
        self.assertEqual(response.status_code, 101)
        self.assertNotIn('content-length', response.headers)
        self.assertEqual(response.headers['upgrade'], 'websocket')

    def test_intentional_tunnel_interruption_survives_lifecycle_callbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, 'a' * 32, 47821)
            client = Mock(id='client', tls=False, sni=None, peername=('127.0.0.1', 1234))
            flow = SimpleNamespace(id='tunnel', client_conn=client, error='Connection closed', response=None,
                                   request=SimpleNamespace(host='api.example.com', port=443),
                                   server_conn=SimpleNamespace(address=('api.example.com', 443), peername=None))
            handler = Mock(client=client, transports={client: SimpleNamespace(handler=Mock())})
            service.master = SimpleNamespace(addons=SimpleNamespace(get=lambda _: SimpleNamespace(connections={'client': handler})))
            service.http_connect(flow)
            service.http_connected(flow)
            service.settings['tlsDomains'] = ['api.example.com']
            # Closing can synchronously emit disconnect/error hooks.
            handler.close_connection.side_effect = lambda _: service.http_connect_error(flow)
            self.assertEqual(service.interrupt_newly_inspected_tunnels([]), 1)
            record = service.records[flow.id]
            self.assertEqual(record['state'], 'interrupted')
            self.assertEqual(record['interruptionReason'], SSL_INTERRUPTION_REASON)
            self.assertNotIn('error', record)
            self.assertGreaterEqual(record['durationMs'], 0)
            ended = record['endedAt']
            callbacks = [lambda: service.http_connected(flow), lambda: service.http_connect_error(flow),
                         lambda: service.server_connect_error(SimpleNamespace(client=client, server=SimpleNamespace(error='refused'))),
                         lambda: service.tls_failed_client(SimpleNamespace(context=SimpleNamespace(client=client), conn=SimpleNamespace(error='TLS failed'))),
                         lambda: service.error(flow), service.done, lambda: service.client_disconnected(client)]
            for callback in callbacks:
                callback()
                self.assertEqual(record['state'], 'interrupted')
                self.assertNotIn('error', record)
                self.assertEqual(record['endedAt'], ended)
            self.assertEqual(service.state()['records'][0]['interruptionReason'], SSL_INTERRUPTION_REASON)
            service.db.close()

    def test_legacy_interruption_migration_preserves_genuine_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, 'a' * 32, 47821)
            errors = {'legacy': SSL_INTERRUPTION_REASON, 'real': 'TLS handshake failed',
                      'similar': SSL_INTERRUPTION_REASON + ' Other failure.'}
            for record_id, error in errors.items():
                service.save({'id': record_id, 'kind': 'tunnel', 'startedAt': 1, 'state': 'pending'})
                service.cancel(record_id, error)
            service.cancel('real', 'Connection closed')
            legacy_ended = service.records['legacy']['endedAt']
            service.db.close()
            service = Service(directory, 'a' * 32, 47821)
            legacy = service.records['legacy']
            self.assertEqual(legacy['state'], 'interrupted')
            self.assertEqual(legacy['interruptionReason'], SSL_INTERRUPTION_REASON)
            self.assertNotIn('error', legacy)
            self.assertEqual(legacy['endedAt'], legacy_ended)
            for record_id in ('real', 'similar'):
                self.assertEqual(service.records[record_id]['state'], 'error')
                self.assertEqual(service.records[record_id]['error'], errors[record_id])
            service.db.close()

    def test_changing_response_to_websocket_upgrade_is_rejected(self):
        response = http.Response.make(200, b'original')
        with self.assertRaises(ValueError):
            apply_message(response, {**message_value(response), 'statusCode': 101})

    def test_streamed_request_preserves_unavailable_body_and_framing(self):
        request = http.Request.make('POST', 'http://localhost/upload', b'')
        request.raw_content = None
        request.stream = True
        request.headers['content-length'] = '20000000'
        value = message_value(request, True)
        self.assertTrue(value['bodyUnavailable'])
        apply_message(request, value, True)
        self.assertIsNone(request.raw_content)
        self.assertEqual(request.headers['content-length'], '20000000')
        with self.assertRaisesRegex(ValueError, 'Streamed body'):
            apply_message(request, {**value, 'body': 'replacement'}, True)

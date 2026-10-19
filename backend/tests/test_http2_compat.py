"""Synthetic HTTP/2 TLS traffic through the real loopback proxy."""

import asyncio
import contextlib
import ssl
import unittest
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path

import h2.config
import h2.connection
import h2.events
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from hpack import Encoder
from hyperframe.frame import Frame, GoAwayFrame, HeadersFrame, RstStreamFrame


class Http2CompatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Reuse the isolated engine, temporary CA and origin certificate fixture.
        from backend.tests.test_integration import ProxyIntegrationTests
        self.fixture = ProxyIntegrationTests
        await self.fixture.asyncSetUp(self)
        self.release_events = asyncio.Event()
        self.reset_ready = asyncio.Event()
        self.origin_paths = []
        self.origin_resets = []
        self.h2_clients = []
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.origin_cert, Path(self.directory.name, 'origin.key'))
        tls.set_alpn_protocols(['h2'])
        self.h2_server = await asyncio.start_server(self.handle_origin, '127.0.0.1', 0, ssl=tls)
        self.h2_port = self.h2_server.sockets[0].getsockname()[1]
        async with self.client.put(self.api + '/settings', headers=self.auth, json={'tlsDomains': ['127.0.0.1']}) as response:
            self.assertEqual(response.status, 200, await response.text())

    async def asyncTearDown(self):
        self.release_events.set()
        for writer in self.h2_clients:
            writer.close()
            with contextlib.suppress(ConnectionError, ssl.SSLError):
                await writer.wait_closed()
        self.h2_server.close()
        await self.h2_server.wait_closed()
        await self.fixture.asyncTearDown(self)

    async def handle_origin(self, reader, writer):
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=False))
        paths = {}
        try:
            self.assertEqual(writer.get_extra_info('ssl_object').selected_alpn_protocol(), 'h2')
            conn.initiate_connection()
            writer.write(conn.data_to_send())
            await writer.drain()
            while data := await reader.read(65536):
                for event in conn.receive_data(data):
                    if isinstance(event, h2.events.RequestReceived):
                        path = dict(event.headers)[b':path'].decode()
                        paths[event.stream_id] = path
                        self.origin_paths.append(path)
                    elif isinstance(event, h2.events.StreamEnded):
                        path = paths[event.stream_id]
                        if path == '/reset':
                            conn.send_headers(event.stream_id, [(b':status', b'200')])
                            writer.write(conn.data_to_send())
                            await writer.drain()
                            self.reset_ready.set()
                        elif path == '/events':
                            conn.send_headers(event.stream_id, [(b':status', b'200'), (b'content-type', b'text/event-stream')])
                            conn.send_data(event.stream_id, b'data: first\n\n')
                            writer.write(conn.data_to_send())
                            await writer.drain()
                            await self.release_events.wait()
                            conn.send_data(event.stream_id, b'data: second\n\n', end_stream=True)
                        else:
                            conn.send_headers(event.stream_id, [(b':status', b'200'), (b'content-type', b'text/plain')])
                            conn.send_data(event.stream_id, b'ok', end_stream=True)
                    elif isinstance(event, h2.events.StreamReset):
                        self.origin_resets.append(event.stream_id)
                writer.write(conn.data_to_send())
                await writer.drain()
        except (ConnectionError, ssl.SSLError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError, ssl.SSLError):
                await writer.wait_closed()

    async def open_h2(self, port=None):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.proxy_port)
        target = f'127.0.0.1:{port or self.h2_port}'
        writer.write(f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n'.encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
        self.assertIn(b' 200 ', response.split(b'\r\n', 1)[0])
        proxy_ca = Path(self.directory.name, 'mitmproxy', 'mitmproxy-ca-cert.pem')
        context = ssl.create_default_context(cafile=str(proxy_ca))
        context.set_alpn_protocols(['h2'])
        await writer.start_tls(context, server_hostname='127.0.0.1')
        self.assertEqual(writer.get_extra_info('ssl_object').selected_alpn_protocol(), 'h2')
        self.h2_clients.append(writer)
        return reader, writer

    @staticmethod
    def request_headers(port, path):
        return [(b':method', b'GET'), (b':scheme', b'https'),
                (b':authority', f'127.0.0.1:{port}'.encode()), (b':path', path.encode())]

    async def read_events(self, reader, conn):
        data = await asyncio.wait_for(reader.read(65536), 5)
        self.assertTrue(data, 'HTTP/2 connection closed before a response')
        return conn.receive_data(data)

    async def test_request_and_sse_arrive_incrementally(self):
        reader, writer = await self.open_h2()
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=True))
        conn.initiate_connection()
        conn.send_headers(1, self.request_headers(self.h2_port, '/ok'), end_stream=True)
        writer.write(conn.data_to_send())
        await writer.drain()
        received = bytearray()
        while True:
            events = await self.read_events(reader, conn)
            for event in events:
                if isinstance(event, h2.events.DataReceived) and event.stream_id == 1:
                    received.extend(event.data)
                    conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                if isinstance(event, h2.events.StreamEnded) and event.stream_id == 1:
                    self.assertEqual(received, b'ok')
                    break
            else:
                writer.write(conn.data_to_send())
                await writer.drain()
                continue
            break

        conn.send_headers(3, self.request_headers(self.h2_port, '/events'), end_stream=True)
        writer.write(conn.data_to_send())
        await writer.drain()
        first = bytearray()
        while b'data: first\n\n' not in first:
            for event in await self.read_events(reader, conn):
                if isinstance(event, h2.events.DataReceived) and event.stream_id == 3:
                    first.extend(event.data)
                    conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                self.assertFalse(isinstance(event, h2.events.StreamEnded) and event.stream_id == 3)
            writer.write(conn.data_to_send())
            await writer.drain()
        self.assertEqual(first, b'data: first\n\n')
        self.release_events.set()
        second = bytearray()
        while True:
            for event in await self.read_events(reader, conn):
                if isinstance(event, h2.events.DataReceived) and event.stream_id == 3:
                    second.extend(event.data)
                    conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                if isinstance(event, h2.events.StreamEnded) and event.stream_id == 3:
                    self.assertEqual(second, b'data: second\n\n')
                    self.assertEqual(self.origin_paths, ['/ok', '/events'])
                    return
            writer.write(conn.data_to_send())
            await writer.drain()

    async def test_reset_one_stream_keeps_other_stream_working(self):
        reader, writer = await self.open_h2()
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=True))
        conn.initiate_connection()
        conn.send_headers(1, self.request_headers(self.h2_port, '/reset'), end_stream=True)
        writer.write(conn.data_to_send())
        await writer.drain()
        await asyncio.wait_for(self.reset_ready.wait(), 5)
        conn.send_headers(3, self.request_headers(self.h2_port, '/ok'), end_stream=True)
        conn.reset_stream(1)
        writer.write(conn.data_to_send())
        await writer.drain()
        body = bytearray()
        while True:
            for event in await self.read_events(reader, conn):
                if isinstance(event, h2.events.DataReceived) and event.stream_id == 3:
                    body.extend(event.data)
                    conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                if isinstance(event, h2.events.StreamEnded) and event.stream_id == 3:
                    self.assertEqual(body, b'ok')
                    return
            writer.write(conn.data_to_send())
            await writer.drain()

    async def test_duplicate_host_is_rejected_before_origin(self):
        reader, writer = await self.open_h2()
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=True))
        conn.initiate_connection()
        writer.write(conn.data_to_send())
        frame = HeadersFrame(1)
        frame.data = Encoder().encode([*self.request_headers(self.h2_port, '/duplicate'),
                                       (b'host', b'one.example'), (b'host', b'two.example')])
        frame.flags.add('END_HEADERS')
        frame.flags.add('END_STREAM')
        writer.write(frame.serialize())
        await writer.drain()
        rejected = False
        for _ in range(8):
            header = await asyncio.wait_for(reader.readexactly(9), 5)
            parsed, size = Frame.parse_frame_header(memoryview(header))
            parsed.parse_body(memoryview(await reader.readexactly(size)))
            if isinstance(parsed, (RstStreamFrame, GoAwayFrame)):
                rejected = True
                break
        self.assertTrue(rejected, 'Duplicate Host did not produce an HTTP/2 rejection frame')
        self.assertNotIn('/duplicate', self.origin_paths)

    async def test_untrusted_upstream_certificate_is_rejected(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'localhost')])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
                .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address('127.0.0.1'))]), False)
                .sign(key, hashes.SHA256()))
        cert_path = Path(self.directory.name, 'untrusted.pem')
        key_path = Path(self.directory.name, 'untrusted.key')
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert_path, key_path)
        tls.set_alpn_protocols(['h2'])
        server = await asyncio.start_server(self.handle_origin, '127.0.0.1', 0, ssl=tls)
        try:
            port = server.sockets[0].getsockname()[1]
            reader, writer = await self.open_h2(port)
            conn = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=True))
            conn.initiate_connection()
            conn.send_headers(1, self.request_headers(port, '/untrusted'), end_stream=True)
            writer.write(conn.data_to_send())
            await writer.drain()
            status = None
            while True:
                for event in await self.read_events(reader, conn):
                    if isinstance(event, h2.events.ResponseReceived) and event.stream_id == 1:
                        status = dict(event.headers)[b':status']
                    if isinstance(event, h2.events.StreamEnded) and event.stream_id == 1:
                        self.assertEqual(status, b'502')
                        self.assertNotIn('/untrusted', self.origin_paths)
                        return
                writer.write(conn.data_to_send())
                await writer.drain()
        finally:
            server.close()
            await server.wait_closed()

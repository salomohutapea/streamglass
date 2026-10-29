"""Compressed SSE streams are decoded in bounded pieces; synthetic data only."""
import tempfile
import unittest
from types import SimpleNamespace

import brotli
from mitmproxy.test.tflow import tflow

from backend.service import Service


class RecordingParser:
    def __init__(self):
        self.sizes, self.data = [], bytearray()

    def feed(self, chunk, end):
        self.sizes.append(len(chunk))
        self.data.extend(chunk)
        return []


class BrotliSseDecodingTests(unittest.IsolatedAsyncioTestCase):
    async def test_brotli_output_per_step_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(directory, "synthetic-management-token", 47821)
            try:
                flow = tflow(resp=True)
                parser = RecordingParser()
                service.streams[flow.id] = {"parser": parser, "decoder": brotli.Decompressor(), "sequence": 0, "bytes": 0}
                # A few KiB on the wire that expand to 16 MiB of event data.
                decoded = b"data: " + b"x" * (16 * 1024 * 1024) + b"\n\n"
                wire = brotli.compress(decoded)
                self.assertLess(len(wire), 64 * 1024)
                await service.streamglass_responsechunk(SimpleNamespace(flow=flow, data=wire, end=True, chunks=[]))
                self.assertEqual(bytes(parser.data), decoded)
                # Brotli may return one internal block beyond the requested 64 KiB, never the whole expansion.
                self.assertLessEqual(max(parser.sizes), 256 * 1024)
            finally:
                service.db.close()


if __name__ == "__main__":
    unittest.main()

import gzip
import unittest
import zlib
from unittest.mock import patch

import brotli
import zstandard
from mitmproxy import http

from backend.body_preview import decode_preview
from backend.service import apply_message, message_value


class BoundedBodyTests(unittest.TestCase):
    def encodings(self, raw):
        return {"gzip": gzip.compress(raw), "deflate": zlib.compress(raw),
                "deflateraw": zlib.compress(raw)[2:-4], "br": brotli.compress(raw),
                "zstd": zstandard.ZstdCompressor().compress(raw)}

    def test_compressed_bodies_are_bounded_without_modifying_wire_bytes(self):
        for encoding, raw in self.encodings(b"x" * 100000).items():
            with self.subTest(encoding=encoding), patch("backend.service.MAX_BODY", 1024):
                self.assertLessEqual(len(decode_preview(raw, encoding, 1024)), 1025)
                response = http.Response.make(200, raw, {"content-encoding": encoding})
                response.raw_content = raw
                value = message_value(response)
                self.assertTrue(value["bodyUnavailable"])
                self.assertEqual(value["body"], "")
                self.assertEqual(response.raw_content, raw)
                apply_message(response, {**value, "statusCode": 201})
                self.assertEqual(response.raw_content, raw)
                self.assertEqual(response.headers["content-encoding"], encoding)
                with self.assertRaisesRegex(ValueError, "inspection limit"):
                    apply_message(response, {**value, "body": "replacement"})
                self.assertEqual(response.raw_content, raw)

    def test_normal_compressed_text_keeps_charset_and_binary_representation(self):
        for encoding, raw in self.encodings("caf\u00e9".encode("latin-1")).items():
            with self.subTest(encoding=encoding):
                response = http.Response.make(200, raw, {"content-encoding": encoding,
                    "content-type": "text/plain; charset=iso-8859-1"})
                response.raw_content = raw
                value = message_value(response)
                self.assertEqual(value["body"], "caf\u00e9")
                self.assertNotIn("bodyUnavailable", value)
                apply_message(response, value)
                self.assertEqual(response.raw_content, raw)

    def test_gzip_members_share_the_same_limit(self):
        raw = gzip.compress(b"a" * 800) + gzip.compress(b"b" * 800)
        self.assertEqual(len(decode_preview(raw, "gzip", 1024)), 1025)

    def test_malformed_encoding_is_opaque_and_forwarded_unchanged(self):
        response = http.Response.make(200, b"not-gzip", {"content-encoding": "gzip"})
        response.raw_content = b"not-gzip"
        self.assertEqual(message_value(response)["body"], "not-gzip")
        self.assertEqual(response.raw_content, b"not-gzip")

    def test_oversized_uncompressed_body_does_not_allocate_base64(self):
        with patch("backend.service.MAX_BODY", 1024):
            response = http.Response.make(200, b"x" * 100000)
            value = message_value(response)
            self.assertTrue(value["bodyUnavailable"])
            self.assertEqual(value["bodyBase64"], "")
            self.assertLessEqual(len(value["bodyPreview"]), 65536)
            self.assertEqual(len(response.raw_content), 100000)

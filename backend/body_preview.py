"""Decode inspection previews with a hard output bound; never change wire bytes."""
import gzip
import io
import zlib


def decode_preview(raw, encoding, limit):
    encoding = encoding.strip().lower()
    if encoding in ("", "identity"):
        return raw[:limit + 1]
    if encoding == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
            return stream.read(limit + 1)
    if encoding in ("deflate", "deflateraw"):
        try:
            return zlib.decompressobj(-15 if encoding == "deflateraw" else 15).decompress(raw, limit + 1)
        except zlib.error:
            if encoding == "deflateraw":
                raise
            return zlib.decompressobj(-15).decompress(raw, limit + 1)
    if encoding == "br":
        import brotli
        decoder = brotli.Decompressor()
        result = bytearray()
        pending = raw
        while not decoder.is_finished():
            chunk = decoder.process(pending, output_buffer_limit=min(65536, limit + 1 - len(result)))
            # Brotli can return one internal block beyond the requested bound.
            result.extend(chunk[:limit + 1 - len(result)])
            if len(result) > limit:
                break
            pending = b""
            if decoder.can_accept_more_data() and not decoder.is_finished():
                raise ValueError("Incomplete Brotli body")
        return bytes(result)
    if encoding == "zstd":
        import zstandard
        with zstandard.ZstdDecompressor(max_window_size=8 * 1024 * 1024).stream_reader(io.BytesIO(raw)) as stream:
            return stream.read(limit + 1)
    raise ValueError("Unsupported content encoding")


def text_preview(message, limit):
    raw = message.raw_content or b""
    encoding = message.headers.get("content-encoding", "")
    decoded = decode_preview(raw, encoding, limit)
    if len(decoded) > limit:
        return "", decoded[:65536].decode("utf-8", "replace"), True
    # Preserve mitmproxy's charset detection, but never ask it to decompress.
    clone = message.copy()
    clone.headers.pop("content-encoding", None)
    clone.raw_content = decoded
    return clone.get_text(strict=False) or "", "", False

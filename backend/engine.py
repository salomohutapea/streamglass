"""Version-checked in-memory engine extension; installed mitmproxy files stay intact."""
import ast
import inspect
import textwrap
from dataclasses import dataclass
from importlib.metadata import version


def patch_engine(on_cancel):
    if version("mitmproxy") != "12.2.3+streamglass.1":
        raise RuntimeError("Streamglass requires mitmproxy 12.2.3+streamglass.1; run npm run setup")
    from mitmproxy.proxy import commands
    from mitmproxy.proxy.layers import http as engine
    from mitmproxy.proxy.layers.http._events import ResponseData, RequestProtocolError, ResponseProtocolError

    # The live connection handler accepts one lifecycle argument per hook.
    @dataclass
    class HttpResponseChunkHook(commands.StartHook):
        name = "streamglass_responsechunk"
        flow: object
        data: bytes
        end: bool
        chunks: list

        def args(self):
            return [self]

    @dataclass
    class HttpSseEventHook(commands.StartHook):
        name = "streamglass_sseevent"
        flow: object
        event: dict
        output: list

        def args(self):
            return [self]

    engine.HttpSseEventHook = HttpSseEventHook
    engine.HttpResponseChunkHook = HttpResponseChunkHook
    @dataclass
    class HttpResponseStreamHook(commands.StartHook):
        name = "streamglass_responsestream"
        flow: object

    engine.HttpResponseStreamHook = HttpResponseStreamHook
    original_check_size = getattr(engine.HttpStream.check_body_size, "_streamglass_original", engine.HttpStream.check_body_size)

    def check_body_size(self, request):
        if request and self.flow.metadata.get("streamglass_map_buffer") and not self.flow.metadata.get("streamglass_passthrough"):
            if len(self.request_body_buf) > 8 * 1024 * 1024:
                message = "Map Local requires request uploads of at most 8 MiB; no upstream request was sent."
                self.flow.metadata["streamglass_map_upload_error"] = message
                yield from self.handle_protocol_error(ResponseProtocolError(self.stream_id, message, engine.ErrorCode.REQUEST_TOO_LARGE))
                return True
            return False
        return (yield from original_check_size(self, request))

    check_body_size._streamglass_original = original_check_size
    engine.HttpStream.check_body_size = check_body_size
    original_start_stream = engine.HttpStream.start_response_stream

    def start_response_stream(self):
        from .large_body import DEFERRED_KEY

        if self.flow.metadata.pop(DEFERRED_KEY, False):
            yield HttpResponseStreamHook(self.flow)
            if (yield from self.check_killed(True)):
                return
        yield from original_start_stream(self)

    engine.HttpStream.start_response_stream = start_response_stream
    method = engine.HttpStream.state_stream_response_body
    source = textwrap.dedent(inspect.getsource(method))
    for argument, end in (("event.data", "False"), ('b""', "True")):
        old = f"chunks = self.flow.response.stream({argument})"
        if source.count(old) != 1:
            raise RuntimeError("Unexpected mitmproxy streaming implementation; refusing patch")
        rewritten = []
        for line in source.splitlines():
            if line.strip() == old:
                indent = line[:len(line) - len(line.lstrip())]
                rewritten.extend(indent + code for code in [
                    'if self.flow.metadata.get("streamglass_sse_stream"):',
                    f"    hook = HttpResponseChunkHook(self.flow, {argument}, {end}, [])",
                    "    yield hook",
                    "    if (yield from self.check_killed(True)):",
                    "        return",
                    "    chunks = hook.chunks",
                    "else:",
                    "    " + old,
                ])
            else:
                rewritten.append(line)
        source = "\n".join(rewritten) + "\n"
    lines = []
    for line in source.splitlines():
        lines.append(line)
        if line.strip() == "for chunk in chunks:":
            indent = line[:len(line) - len(line.lstrip())] + "    "
            lines.extend(indent + code for code in [
                "if isinstance(chunk, dict):",
                "    event_hook = HttpSseEventHook(self.flow, chunk, [])",
                "    yield event_hook",
                "    if (yield from self.check_killed(True)):",
                "        return",
                "    chunk = b\"\".join(event_hook.output)",
            ])
    source = "\n".join(lines) + "\n"
    namespace = {}
    exec(compile(source, "<streamglass-engine-extension>", "exec"), vars(engine), namespace)
    engine.HttpStream.state_stream_response_body = namespace["state_stream_response_body"]
    @dataclass
    class HttpTransferHook(commands.StartHook):
        name = "streamglass_transfer"
        flow: object
        size: int
        upload: bool
        delay_ms: int = 0
        disconnect: bool = False

        def args(self):
            return [self]

    engine.HttpTransferHook = HttpTransferHook

    def transfer(stream, command):
        from mitmproxy.proxy.layers.http._events import RequestData
        event = command.event
        frames = stream.flow.metadata.pop("streamglass_timed_frames", None) if isinstance(event, ResponseData) else None
        if frames and not stream.flow.metadata.get("streamglass_passthrough"):
            offset = 0
            for size, delay in frames:
                yield HttpTransferHook(stream.flow, size, False, delay)
                if (yield from stream.check_killed(True)):
                    return
                yield engine.SendHttp(type(event)(event.stream_id, event.data[offset:offset + size]), command.connection)
                offset += size
            if offset < len(event.data):
                yield engine.SendHttp(type(event)(event.stream_id, event.data[offset:]), command.connection)
            if stream.flow.metadata.pop("streamglass_disconnect_after_send", False) and not stream.flow.metadata.get("streamglass_passthrough"):
                yield HttpTransferHook(stream.flow, 0, False, disconnect=True)
            return
        rates = stream.flow.metadata.get("streamglass_transfer_rates", (0, 0))
        upload = isinstance(event, RequestData)
        if (isinstance(event, (RequestData, ResponseData)) and event.data
                and rates[0 if upload else 1] and not stream.flow.metadata.get("streamglass_passthrough")):
            # Small chunks bound burst size without buffering an SSE stream.
            for offset in range(0, len(event.data), 16 * 1024):
                if stream.flow.metadata.get("streamglass_passthrough"):
                    yield engine.SendHttp(type(event)(event.stream_id, event.data[offset:]), command.connection)
                    return
                data = event.data[offset:offset + 16 * 1024]
                yield HttpTransferHook(stream.flow, len(data), isinstance(event, RequestData))
                if (yield from stream.check_killed(True)):
                    return
                yield engine.SendHttp(type(event)(event.stream_id, data), command.connection)
        else:
            yield command
        if isinstance(event, ResponseData) and stream.flow.metadata.pop("streamglass_disconnect_after_send", False) and not stream.flow.metadata.get("streamglass_passthrough"):
            yield HttpTransferHook(stream.flow, 0, False, disconnect=True)

    engine.streamglass_transfer_command = transfer

    class TransferYields(ast.NodeTransformer):
        def visit_Yield(self, node):
            if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == "SendHttp":
                return ast.copy_location(ast.YieldFrom(ast.Call(
                    func=ast.Name(id="streamglass_transfer_command", ctx=ast.Load()),
                    args=[ast.Name(id="self", ctx=ast.Load()), node.value], keywords=[])), node)
            return node

    for name in ("state_wait_for_request_headers", "state_stream_request_body", "state_consume_request_body", "send_response", "state_stream_response_body"):
        method = getattr(engine.HttpStream, name)
        original_method = getattr(method, "_streamglass_original", method)
        method_source = source if name == "state_stream_response_body" else textwrap.dedent(inspect.getsource(original_method))
        if name == "state_wait_for_request_headers":
            before = "    yield HttpRequestHeadersHook(self.flow)"
            after = before + "\n" + "\n".join([
                "    if self.flow.metadata.get('streamglass_map_upload_error'):",
                "        yield from self.send_response()",
                "        self.client_state = self.server_state = self.state_errored",
                "        return",
            ])
            if method_source.count(before) != 1:
                raise RuntimeError("Unexpected request header dispatch; refusing engine patch")
            method_source = method_source.replace(before, after)
        if name == "state_consume_request_body":
            before = "            yield from self.send_response()"
            after = "\n".join([
                "            if self.flow.response is None:",
                "                self.request_body_buf += self.flow.request.raw_content or b''",
                "                yield from self.state_consume_request_body(event)",
                "                return",
                before,
            ])
            if method_source.count(before) != 1:
                raise RuntimeError("Unexpected synthetic-response dispatch; refusing engine patch")
            method_source = method_source.replace(before, after)

        if name == "send_response":
            before = "    yield HttpResponseHook(self.flow)"
            after = before + "\n" + "\n".join([
                "    if self.flow.response is None:",
                "        self.request_body_buf += self.flow.request.raw_content or b''",
                "        yield from self.state_consume_request_body(RequestEndOfMessage(self.stream_id))",
                "        return",
            ])
            if method_source.count(before) != 1:
                raise RuntimeError("Unexpected response hook dispatch; refusing engine patch")
            method_source = method_source.replace(before, after)
        tree = ast.fix_missing_locations(TransferYields().visit(ast.parse(method_source)))
        namespace = {}
        exec(compile(tree, "<streamglass-transfer-extension>", "exec"), vars(engine), namespace)
        patched = namespace[name]
        patched._streamglass_original = original_method
        setattr(engine.HttpStream, name, patched)

    original = engine.HttpStream.handle_event

    def bounded_handle(self, event):
        if self._paused:
            queued = sum(len(getattr(item, "data", b"")) for item in self._paused_event_queue)
            queued += len(getattr(event, "data", b""))
            if queued > 8 * 1024 * 1024 or len(self._paused_event_queue) > 4096:
                self.flow.kill()
                self._paused_event_queue.clear()
                on_cancel(self.flow.id, "Paused stream exceeded 8 MiB queue limit")
                return
            if isinstance(event, (RequestProtocolError, ResponseProtocolError)):
                on_cancel(self.flow.id, "Peer disconnected while paused")
        yield from original(self, event)

    engine.HttpStream.handle_event = bounded_handle

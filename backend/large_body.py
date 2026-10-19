"""Bounded capture for REST bodies that mitmproxy forwards without buffering."""
import copy

MAX_BUFFERED_BODY = 8 * 1024 * 1024
MAX_PREVIEW = 64 * 1024
CAPTURE_KEY = "streamglass_large_response"
DEFERRED_KEY = "streamglass_deferred_response"


def apply_streamed_headers(message, value):
    from .service import apply_message

    if value.get("body", "") or value.get("bodyBase64", ""):
        raise ValueError("Response body editing is unavailable for large or unknown-length streamed responses; edit only headers and status.")
    edited = copy.deepcopy(message)
    apply_message(edited, value, headers_only=True)
    if edited.status_code in (204, 304):
        edited.headers.pop("content-length", None)
        edited.headers.pop("transfer-encoding", None)
    else:
        for name in ("content-length", "transfer-encoding", "content-encoding"):
            if edited.headers.get_all(name) != message.headers.get_all(name):
                raise ValueError(f"Cannot edit {name} without the complete streamed body.")
    message.headers, message.status_code = edited.headers, edited.status_code


def warn(service, flow, message):
    record = service.records.get(flow.id)
    if record is not None:
        previous = record.get("captureWarning", "")
        if message not in previous:
            record["captureWarning"] = (previous + " " + message).strip()


async def before_responseheaders(service, flow, *, streaming=False):
    """Run response header rules before an oversized response can start streaming."""
    from .service import message_value

    response = flow.response
    if ("text/event-stream" in response.headers.get("content-type", "").lower()
            or flow.request.method == "HEAD" or response.status_code in (101, 204, 304)):
        return False
    length = response.headers.get("content-length")
    known_length = int(length) if length is not None and length.isdecimal() else None
    if not streaming:
        if known_length is None:
            # Let mitmproxy buffer up to 8 MiB before choosing streaming.
            flow.metadata[DEFERRED_KEY] = True
            return False
        if known_length <= MAX_BUFFERED_BODY:
            return False

    flow.metadata[CAPTURE_KEY] = {"preview": bytearray(), "bytes": 0}
    value = message_value(response)
    value["bodyUnavailable"] = True
    value["bodyUnavailableReason"] = "Response body is unavailable before streaming; only headers and status can be edited."
    edited = await service.process(flow, "response", value)
    if edited != value:
        apply_streamed_headers(response, edited)
    flow.metadata["streamglass_response_processed"] = True
    def forward(chunk):
        if response.status_code in (204, 304):
            return b""
        observe_responsechunk(service, flow, chunk)
        return chunk
    response.stream = forward
    return True


def observe_responsechunk(service, flow, data):
    capture = flow.metadata.get(CAPTURE_KEY)
    if capture is None:
        return
    capture["bytes"] += len(data)
    remaining = MAX_PREVIEW - len(capture["preview"])
    if remaining > 0:
        capture["preview"].extend(data[:remaining])
    warn(service, flow, "Response body was streamed unchanged; capture contains only a bounded preview. Full body export and body editing are unavailable.")


def complete_response(service, flow):
    capture = flow.metadata.pop(CAPTURE_KEY, None)
    if capture is None or flow.response.raw_content is not None:
        return False
    from .service import message_value

    record = service.records.get(flow.id)
    if record is not None:
        value = message_value(flow.response)
        value.update(bodyUnavailable=True, bodyBytes=capture["bytes"],
                     bodyPreview=capture["preview"].decode("utf-8", "replace"),
                     bodyPreviewBytes=len(capture["preview"]),
                     bodyPreviewEncoding="raw-utf8")
        record.update(response=value, statusCode=flow.response.status_code, state="complete")
        service.save(record)
    return True

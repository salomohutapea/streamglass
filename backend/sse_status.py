"""SSE connection status: the live phase of a stream and a structured reason for how it ended."""

END_REASONS = ("server-closed", "client-closed", "server-dropped", "stream-reset", "proxy-closed", "error")
ENDED_STATES = ("complete", "error", "interrupted")


def classify_end(text):
    """Map an end message (mitmproxy's flow error text, or a legacy endReason) to an END_REASONS code.

    mitmproxy reports HTTP/2 resets from either peer as "stream reset by client (CODE)". A CANCEL reset is what a
    client sends when it aborts, so it counts as client-closed; any other reset code stays side-neutral."""
    value = (text or "").lower()
    if not value or value == "upstream-eof":
        return "server-closed"
    if "client disconnected" in value or "stream reset by client (cancel)" in value:
        return "client-closed"
    if "stream reset" in value:
        return "stream-reset"
    if "server closed connection" in value or "peer closed connection" in value or "server disconnected" in value or "incomplete" in value:
        return "server-dropped"
    if "connection killed" in value or value == "killed":
        return "proxy-closed"
    return "error"


def end_reason(record):
    """Return the end reason code of an ended SSE record, or None while it is still open."""
    if record.get("state") not in ENDED_STATES:
        return None
    diagnostics = record.get("sseDiagnostics") or {}
    stored = diagnostics.get("endReason")
    if stored in END_REASONS:
        return stored
    if record.get("state") == "interrupted":
        return "proxy-closed"
    if stored:
        return classify_end(stored)
    if record.get("state") == "complete":
        return "server-closed"
    return classify_end(record.get("error"))


def sse_status(record):
    """connecting -> open (headers received) -> streaming (events arriving) -> an END_REASONS code."""
    ended = end_reason(record)
    if ended:
        return ended
    diagnostics = record.get("sseDiagnostics") or {}
    if diagnostics.get("firstEventAt") or record.get("eventCount"):
        return "streaming"
    if diagnostics.get("headersAt"):
        return "open"
    return "connecting"


def finish(record):
    """Record the end reason, the original message and the end time once, when an SSE record reaches an ended state.
    A reason already set as a code (for example proxy-closed, set before Streamglass kills a flow) is kept."""
    diagnostics = record.get("sseDiagnostics")
    if not diagnostics or record.get("state") not in ENDED_STATES or diagnostics.get("endedAt"):
        return
    detail = record.get("error") or record.get("interruptionReason") or ""
    if diagnostics.get("endReason") not in END_REASONS:
        detail = detail or diagnostics.get("endReason") or ""
        diagnostics["endReason"] = ("proxy-closed" if record.get("state") == "interrupted" else
                                    "server-closed" if record.get("state") == "complete" else classify_end(detail))
    diagnostics["endDetail"] = detail
    diagnostics["endedAt"] = record.get("endedAt")

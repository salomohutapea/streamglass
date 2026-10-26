"""Per-request timing breakdown and SSE gap statistics. Pure functions over flow-like objects; nothing here touches traffic."""
import bisect
import math
from collections import deque


def _ms(seconds):
    return seconds * 1000 if isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds > 0 else None


def note_pause(flow, stage, started, ended):
    """Accumulate breakpoint time. Request-stage pauses precede the upstream send; later pauses sit inside the response phase."""
    paused = flow.metadata.setdefault("streamglass_paused", {"request": 0.0, "response": 0.0})
    paused["request" if stage == "request" else "response"] += max(0.0, ended - started) * 1000


def compute_timings(flow, forwarded_at, response_end):
    """Epoch-millisecond timestamps plus derived durations.

    requestSent is when the proxy actually handed the request upstream: the later of the moment the request hook
    released it (after rules and breakpoints) and the upstream TCP/TLS handshake completing. Breakpoint time therefore
    never counts as server time; it is reported separately as pausedMs and removed from downloadMs.
    """
    timings = {}
    request, response, server = getattr(flow, "request", None), getattr(flow, "response", None), getattr(flow, "server_conn", None)
    paused = flow.metadata.get("streamglass_paused") or {}
    timings["requestStart"] = _ms(getattr(request, "timestamp_start", None))
    connect_start, tcp_done, tls_done = (_ms(getattr(server, name, None)) for name in ("timestamp_start", "timestamp_tcp_setup", "timestamp_tls_setup"))
    timings.update(connectStart=connect_start, tcpSetup=tcp_done, tlsSetup=tls_done)
    sent = max((value for value in (_ms(forwarded_at), tls_done or tcp_done) if value is not None), default=None)
    timings["requestSent"] = sent
    timings["responseHeaders"] = _ms(getattr(response, "timestamp_start", None))
    timings["responseEnd"] = _ms(response_end)
    def span(start, end):
        return max(0.0, end - start) if start is not None and end is not None else None
    timings["connectMs"] = span(connect_start, tcp_done)
    timings["tlsMs"] = span(tcp_done, tls_done)
    timings["serverMs"] = span(sent, timings["responseHeaders"])
    # Time the proxy spent receiving and preparing the request, excluding handshakes and breakpoint pauses.
    before_send = span(timings["requestStart"], sent)
    timings["requestMs"] = max(0.0, before_send - (timings.get("connectMs") or 0) - (timings.get("tlsMs") or 0) - paused.get("request", 0.0)) if before_send is not None else None
    pause_after = paused.get("response", 0.0)
    download = span(timings["responseHeaders"], timings["responseEnd"])
    timings["downloadMs"] = max(0.0, download - pause_after) if download is not None else None
    timings["pausedMs"] = (paused.get("request", 0.0) + pause_after) or None
    return {key: value for key, value in timings.items() if value is not None}


class GapStats:
    """Running gap statistics over the newest `limit` gaps; same output as gap_stats without re-sorting per event."""
    def __init__(self, limit=10000):
        self.limit, self.order, self.sorted, self.total = limit, deque(), [], 0.0

    def add(self, gap):
        self.order.append(gap)
        bisect.insort(self.sorted, gap)
        self.total += gap
        if len(self.order) > self.limit:
            oldest = self.order.popleft()
            del self.sorted[bisect.bisect_left(self.sorted, oldest)]
            self.total -= oldest
        values = self.sorted
        return {"count": len(values), "minMs": values[0], "avgMs": self.total / len(values),
                "p95Ms": values[max(0, math.ceil(0.95 * len(values)) - 1)], "maxMs": values[-1]}


def gap_stats(gaps):
    """min/avg/p95/max over inter-event gaps in milliseconds (nearest-rank p95)."""
    values = sorted(gaps)
    if not values:
        return {}
    return {"count": len(values), "minMs": values[0], "avgMs": sum(values) / len(values),
            "p95Ms": values[max(0, math.ceil(0.95 * len(values)) - 1)], "maxMs": values[-1]}

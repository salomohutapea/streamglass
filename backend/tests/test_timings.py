import unittest
from types import SimpleNamespace

from backend.timings import compute_timings, gap_stats, note_pause


def fake_flow(**server):
    return SimpleNamespace(metadata={}, request=SimpleNamespace(timestamp_start=100.0, timestamp_end=100.01),
                           response=SimpleNamespace(timestamp_start=100.9, timestamp_end=101.4),
                           server_conn=SimpleNamespace(**{"timestamp_start": 100.02, "timestamp_tcp_setup": 100.07, "timestamp_tls_setup": 100.15, **server}))


class TimingTests(unittest.TestCase):
    def test_breakdown_from_epoch_seconds(self):
        timings = compute_timings(fake_flow(), 100.05, 101.4)
        self.assertEqual(timings["requestStart"], 100000)
        self.assertAlmostEqual(timings["connectMs"], 50)
        self.assertAlmostEqual(timings["tlsMs"], 80)
        self.assertAlmostEqual(timings["requestSent"], 100150)  # waits for the upstream handshake
        self.assertAlmostEqual(timings["serverMs"], 750)
        self.assertAlmostEqual(timings["requestMs"], 20)
        self.assertAlmostEqual(timings["downloadMs"], 500)
        self.assertNotIn("pausedMs", timings)

    def test_breakpoint_time_is_not_server_time(self):
        flow = fake_flow(timestamp_tls_setup=None)
        note_pause(flow, "request", 10.0, 70.0)
        note_pause(flow, "response", 20.0, 20.1)
        # The request hook only released the request at 130.0 after a 60 s pause.
        flow.response.timestamp_start, flow.response.timestamp_end = 130.4, 130.9
        timings = compute_timings(flow, 130.0, 130.9)
        self.assertAlmostEqual(timings["serverMs"], 400)
        self.assertAlmostEqual(timings["downloadMs"], 400)  # 500 ms minus the 100 ms response-side pause
        self.assertAlmostEqual(timings["pausedMs"], 60100)

    def test_missing_values_are_omitted(self):
        flow = SimpleNamespace(metadata={}, request=SimpleNamespace(timestamp_start=None), response=None, server_conn=None)
        self.assertEqual(compute_timings(flow, None, None), {})

    def test_cached_or_reused_connection_has_no_handshake(self):
        timings = compute_timings(fake_flow(timestamp_start=None, timestamp_tcp_setup=None, timestamp_tls_setup=None), 100.02, 101.4)
        self.assertNotIn("connectMs", timings)
        self.assertAlmostEqual(timings["serverMs"], 880)

    def test_gap_stats(self):
        self.assertEqual(gap_stats([]), {})
        stats = gap_stats([100.0] * 18 + [10.0, 1000.0])
        self.assertEqual((stats["count"], stats["minMs"], stats["maxMs"], stats["p95Ms"]), (20, 10.0, 1000.0, 100.0))
        self.assertAlmostEqual(stats["avgMs"], 140.5)


if __name__ == "__main__":
    unittest.main()

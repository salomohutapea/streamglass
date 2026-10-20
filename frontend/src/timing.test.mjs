import test from 'node:test';
import assert from 'node:assert/strict';
import { waterfallSegments, longGapThreshold, gapSummary, eventGaps, formatMs } from './timing.mjs';

test('waterfall keeps only known segments and proportions sum to 100', () => {
  const segments = waterfallSegments({ connectMs: 50, tlsMs: 50, serverMs: 800, downloadMs: 100, pausedMs: null, junk: 5 });
  assert.deepEqual(segments.map(s => s.key), ['connectMs', 'tlsMs', 'serverMs', 'downloadMs']);
  assert.equal(segments[2].offsetPct, 10);
  assert.equal(segments.reduce((sum, s) => sum + s.widthPct, 0), 100);
  assert.deepEqual(waterfallSegments(undefined), []);
});
test('long gaps are over three times the median and need enough samples', () => {
  assert.equal(longGapThreshold([100, 100, 100, 1000]), 300);
  assert.equal(longGapThreshold([100, 1000]), Infinity);
  assert.equal(longGapThreshold([0, 0, 0, 500]), Infinity);
});
test('gap summary and per-event gaps', () => {
  assert.equal(gapSummary([]), undefined);
  assert.deepEqual(gapSummary([10, 20, 30, 40]), { count: 4, minMs: 10, avgMs: 25, p95Ms: 40, maxMs: 40 });
  const gaps = eventGaps([{ receivedAt: 10.1 }, { receivedAt: 10.35 }, { receivedAt: 11, gapMs: 7 }], 10000);
  assert.ok(Math.abs(gaps[0] - 100) < 1e-6 && Math.abs(gaps[1] - 250) < 1e-6 && gaps[2] === 7);
  assert.equal(eventGaps([{ receivedAt: 5 }], undefined)[0], undefined);
  assert.equal(formatMs(120.5), '120.50 ms');
  assert.equal(formatMs(2500), '2.50 s');
});

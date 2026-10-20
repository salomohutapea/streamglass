/** Timing display helpers. Timings come from the engine in milliseconds (see docs/FEATURE_CONTRACTS.md). */
export const segmentDefinitions = [
  ['connectMs', 'Connect'], ['tlsMs', 'TLS'], ['requestMs', 'Request'], ['serverMs', 'Server wait'], ['downloadMs', 'Download'], ['pausedMs', 'Paused'],
];
export function waterfallSegments(timings) {
  if (!timings || typeof timings !== 'object') return [];
  const segments = segmentDefinitions.map(([key, label]) => ({ key, label, ms: timings[key] })).filter(item => Number.isFinite(item.ms) && item.ms >= 0);
  const total = segments.reduce((sum, item) => sum + item.ms, 0);
  let offset = 0;
  return segments.map(item => { const result = { ...item, offsetPct: total ? offset / total * 100 : 0, widthPct: total ? item.ms / total * 100 : 0 }; offset += item.ms; return result; });
}
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
/** Gaps over three times the median are flagged; with fewer than 4 gaps or a zero median nothing is. */
export function longGapThreshold(gaps) {
  const middle = median(gaps);
  return gaps.filter(Number.isFinite).length >= 4 && middle > 0 ? middle * 3 : Infinity;
}
export function gapSummary(gaps) {
  const sorted = gaps.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return { count: sorted.length, minMs: sorted[0], avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95Ms: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)], maxMs: sorted.at(-1) };
}
export function eventGaps(events, headersAtMs) {
  let previous = headersAtMs;
  return events.map(event => {
    if (Number.isFinite(event.gapMs)) { previous = event.receivedAt * 1000; return event.gapMs; }
    const at = Number.isFinite(event.receivedAt) ? event.receivedAt * 1000 : undefined;
    const gap = at !== undefined && previous !== undefined ? Math.max(0, at - previous) : undefined;
    if (at !== undefined) previous = at;
    return gap;
  });
}
export const formatMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(2)} ms`;

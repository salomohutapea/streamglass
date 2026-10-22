// Gates that disappeared from the engine without being resolved in this window, and whose flow then ended in an
// error: the connection was cut while paused, usually because the app or the server stopped waiting.
export function endedGates(seen, live, resolved, records = [], now = Date.now()) {
  const ended = [];
  for (const [token, gate] of seen) {
    if (live.has(token) || resolved.has(token)) continue;
    const record = records.find(item => item.id === gate.recordId);
    if (record?.state === 'error') ended.push({ gate, reason: record.error || 'The connection closed', pausedMs: now - (gate.pausedAt ?? now) });
  }
  return ended;
}

export const isDisconnect = reason => /disconnect/i.test(reason);

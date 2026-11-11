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

// Live gates and gates whose connection ended while paused, in one list, oldest pause first. An ended gate keeps
// the place it had while it was live; equal timestamps keep the given order (live gates in server order first).
export function pausedEntries(live, ended) {
  return [...live.map(gate => ({ gate, ended: null })), ...ended.map(item => ({ gate: item.gate, ended: item }))]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.gate.pausedAt ?? 0) - (b.entry.gate.pausedAt ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
}

// What the user can no longer do with a paused message once its connection is gone.
export function endedConsequence(stage) {
  if (stage === 'event') return 'The device can no longer receive this event.';
  if (stage === 'response') return 'The device can no longer receive this response.';
  return 'This request can no longer be sent, and the device will not get a response.';
}

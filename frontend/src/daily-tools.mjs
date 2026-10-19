export function groupJourneys(records, analysis, now = Date.now() / 1000) {
  const parents = new Map(records.map(record => [record.id, record.id]));
  function root(id) { let current = id; while (parents.get(current) !== current) current = parents.get(current); while (id !== current) { const next = parents.get(id); parents.set(id, current); id = next; } return current; }
  const owners = new Map();
  for (const record of records) for (const value of analysis[record.id]?.correlations ?? []) {
    const key = JSON.stringify([record.device ?? '', value]);
    if (owners.has(key)) parents.set(root(record.id), root(owners.get(key)));
    else owners.set(key, record.id);
  }
  const groups = new Map();
  for (const record of records) {
    const id = root(record.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return [...groups.values()].map(items => {
    items.sort((a, b) => a.startedAt - b.startedAt);
    const start = items[0].startedAt;
    const end = Math.max(start, ...items.map(r => r.endedAt ?? (r.durationMs != null ? r.startedAt + r.durationMs / 1000 : ['complete','error','interrupted'].includes(r.state) ? r.startedAt : now)));
    const firstData = items.map(r => analysis[r.id]?.firstDataAt).filter(Number.isFinite);
    const firstInventory = items.map(r => analysis[r.id]?.firstInventoryAt).filter(Number.isFinite);
    const correlations = [...new Set(items.flatMap(r => analysis[r.id]?.correlations ?? []))];
    return {id: items[0].id, title: correlations[0] ?? 'Uncorrelated request', device: items[0].device,
      correlations, durationMs: Math.max(1, (end - start) * 1000), startedAt: start,
      firstDataMs: firstData.length ? Math.max(0, (Math.min(...firstData) - start) * 1000) : null,
      firstInventoryMs: firstInventory.length ? Math.max(0, (Math.min(...firstInventory) - start) * 1000) : null,
      records: items.map(record => ({...record, offsetMs: Math.max(0, (record.startedAt - start) * 1000),
        elapsedMs: Math.max(0, ((record.endedAt ?? (['complete','error','interrupted'].includes(record.state) ? record.startedAt + (record.durationMs ?? 0) / 1000 : now)) - record.startedAt) * 1000)}))};
  }).sort((a, b) => b.startedAt - a.startedAt);
}

export function assertionCounts(rows) {
  const counts = {pass: 0, fail: 0, pending: 0, unknown: 0};
  for (const row of Object.values(rows)) for (const assertion of row.assertions ?? []) if (assertion.result in counts) counts[assertion.result]++;
  return counts;
}

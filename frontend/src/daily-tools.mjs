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
    return {id: items[0].id, correlated: correlations.length > 0, title: correlations[0] ?? 'Uncorrelated request', device: items[0].device,
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

const idName = /(^|[^a-z])(search|request|req|trace|span|correlation|corr|session|transaction|txn|journey|flow|operation|order|booking|query|conversation)[-_]?(id|key|token)$|^(trace|request|correlation)[-_]?id$/i;
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headerName = /^(x-[a-z0-9-]*(request|trace|correlation|span|session|search|transaction)[a-z0-9-]*|traceparent|request-id|correlation-id)$/i;
const asJson = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
const keyOf = name => /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;

/** Every scalar leaf of a JSON value as {path, value}. Arrays contribute [0..maxIndex]. Bounded. */
export function flattenJsonPaths(value, {limit = 300, maxDepth = 8, maxIndex = 2} = {}) {
  const out = [];
  (function walk(node, path, depth) {
    if (out.length >= limit) return;
    if (node === null || typeof node !== 'object') { out.push({path, value: node}); return; }
    if (depth >= maxDepth) return;
    if (Array.isArray(node)) node.slice(0, maxIndex + 1).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
    else for (const [key, item] of Object.entries(node)) walk(item, path + keyOf(key), depth + 1);
  })(value, '$', 0);
  return out;
}

/**
 * Find ID-like fields that could correlate requests. `captures` are full records
 * ({request:{headers,body}, response:{headers,body}, events:[{data}]}).
 * Returns [{kind:'path'|'header', key, count, sample}] sorted by how many captures carry the key.
 */
export function detectCorrelationKeys(captures, {limit = 12} = {}) {
  const found = new Map();
  const add = (kind, key, id, sample) => {
    const id_ = `${kind}:${key}`; const entry = found.get(id_) ?? {kind, key, ids: new Set(), sample: String(sample)};
    entry.ids.add(id); found.set(id_, entry);
  };
  for (const capture of captures) {
    const id = capture.id ?? Math.random();
    const bodies = [capture.request?.body, capture.response?.body, ...(capture.events ?? []).slice(0, 5).map(event => event.data)];
    for (const body of bodies) {
      const parsed = asJson(body); if (parsed === null || typeof parsed !== 'object') continue;
      for (const {path, value} of flattenJsonPaths(parsed)) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value); const leaf = path.replace(/\[\d+\]$/, '').split(/[.[\]"]+/).filter(Boolean).pop() ?? '';
        const named = idName.test(leaf) && text.length >= 4; const generic = /id$/i.test(leaf) && (uuidLike.test(text) || /^[0-9a-f]{16,}$/i.test(text));
        if (named || generic) add('path', path.replace(/\[\d+\]/g, '[*]'), id, text);
      }
    }
    for (const section of [capture.request, capture.response]) for (const [name, text] of Array.isArray(section?.headers) ? section.headers : []) {
      if (headerName.test(String(name))) add('header', String(name).toLowerCase(), id, text);
    }
  }
  return [...found.values()].map(({ids, ...rest}) => ({...rest, count: ids.size, sample: rest.sample.slice(0, 80)}))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, limit);
}

/** min/avg/max/p95 (nearest-rank) of finite durations; null when there are none. */
export function durationStats(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  return {count: list.length, min: list[0], max: list.at(-1), avg: list.reduce((a, b) => a + b, 0) / list.length, p95: list[Math.max(0, Math.ceil(list.length * 0.95) - 1)]};
}

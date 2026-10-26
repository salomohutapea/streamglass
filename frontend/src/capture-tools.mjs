const SOURCE_BUDGET = 4 * 1024 * 1024;
// Comparison runs in a worker, so it may read both captures in full: each is at most 32 MiB when retained.
const COMPARE_BUDGET = 80 * 1024 * 1024;
const sourceBytes = (text, remaining = SOURCE_BUDGET) => text.length > remaining ? remaining + 1 : new TextEncoder().encode(text).length;
const sensitive = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'password', 'token', 'access_token', 'refresh_token', 'secret', 'api_key', 'x-api-key'];
const token = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:])/y;

// Keep scalar lexemes and source offsets; decoding numeric JSON would round large identifiers.
function parse(text) {
  let offset = 0;
  function take() { token.lastIndex = offset; const match = token.exec(text); if (!match) throw new Error('Invalid JSON'); offset = token.lastIndex; return { raw: match[1], start: offset - match[1].length, end: offset }; }
  function value(depth = 0, first = take()) {
    if (depth > 200) throw new Error('JSON is too deeply nested');
    const node = { ...first, children: [], open: first.raw };
    if (!['{', '['].includes(first.raw)) {
      if (/^[}\],:]$/.test(first.raw)) throw new Error('Invalid JSON value');
      return node;
    }
    const close = first.raw === '{' ? '}' : ']'; let next = take(); let index = 0;
    if (next.raw !== close) while (true) {
      let key = String(index++);
      if (first.raw === '{') { if (!next.raw.startsWith('"')) throw new Error('Invalid property'); key = JSON.parse(next.raw); if (take().raw !== ':') throw new Error('Missing colon'); next = take(); }
      const child = value(depth + 1, next); node.children.push({ key, node: child });
      next = take(); if (next.raw === close) break;
      if (next.raw !== ',') throw new Error('Missing comma'); next = take();
    }
    node.end = next.end; node.raw = node.children.length ? undefined : text.slice(node.start, node.end); return node;
  }
  const result = value(); if (text.slice(offset).trim()) throw new Error('Trailing JSON'); return result;
}
const childPath = (path, key) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const ignored = (fields, key, path) => fields.some(field => field === key || field === path || field === path.replace(/^\//, '').replaceAll('/', '.'));
function flatten(node, path, fields, result) {
  if (!node.children.length) { result.set(path, node.raw); return; }
  const occurrences = new Map();
  for (const { key, node: child } of node.children) {
    const count = occurrences.get(key) || 0; occurrences.set(key, count + 1);
    const next = childPath(path, key) + (count ? `#${count + 1}` : '');
    if (!ignored(fields, key, next)) flatten(child, next, fields, result);
  }
}
function body(text, path, fields, result) {
  if (text === undefined) return;
  try { flatten(parse(String(text)), path, fields, result); }
  catch { result.set(path, String(text)); }
}
function headers(value, path, fields, result) {
  const counts = new Map();
  for (const [key, text] of Array.isArray(value) ? value : Object.entries(value || {})) {
    const lower = String(key).toLowerCase(); const count = counts.get(lower) || 0; counts.set(lower, count + 1);
    const next = `${childPath(path, lower)}/${count}`;
    if (!ignored(fields.map(field => field.toLowerCase()), lower, next)) result.set(next, String(text));
  }
}
function captureMap(record, options) {
  const result = new Map(); const fields = options.ignoreFields || []; const section = options.section || 'response';
  if (options.bodyOnly) { if (!ignored(fields, 'body', '/body')) body(record.response?.body ?? '', '/body', fields, result); return result; }
  if (section === 'events') {
    const counts = new Map();
    for (const [index, event] of (record.events || []).entries()) {
      const key = options.eventKey === 'id' ? event.id ?? `missing-${index}` : event.sequence ?? index;
      const occurrence = counts.get(key) || 0; counts.set(key, occurrence + 1);
      const path = childPath('/events', key) + `/${occurrence}`;
      for (const field of ['event', 'id', 'retry']) if (event[field] !== undefined && !ignored(fields, field, childPath(path, field))) result.set(childPath(path, field), String(event[field]));
      if (!ignored(fields, 'data', `${path}/data`)) body(event.data, `${path}/data`, fields, result);
    }
  } else {
    const message = record[section] || {};
    for (const field of section === 'request' ? ['method', 'url'] : ['statusCode', 'reason']) {
      const value = message[field] ?? (section === 'request' ? record[field] : undefined);
      if (value !== undefined && !ignored(fields, field, `/${section}/${field}`)) result.set(`/${section}/${field}`, String(value));
    }
    headers(message.headers, `/${section}/headers`, fields, result);
    if (!ignored(fields, 'body', `/${section}/body`)) body(message.body, `/${section}/body`, fields, result);
  }
  return result;
}
function incomplete(record, section) {
  const value = record[section] || {};
  return record.state !== 'complete' || Boolean(record.captureWarning || record.truncated || record.eventsTruncated || value.bodyUnavailable || value.bodyTruncated || value.truncated || (section === 'events' && record.eventCount > (record.events?.length || 0)));
}
function withinComparisonBudget(left, right, section) {
  let remaining = COMPARE_BUDGET;
  function count(value) {
    if (typeof value === 'string') { remaining -= sourceBytes(value, remaining); return remaining >= 0; }
    if (Array.isArray(value)) return value.every(count);
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (/base64|raw|logs?|bytes|preview|decoded|payload|wire|hex/i.test(key)) continue;
      if (!count(key) || !count(child)) return false;
    }
    return remaining >= 0;
  }
  return [left, right].every(record => section === 'events' ? count(record.events || []) :
    count({ method: record.method, url: record.url, message: record[section] || {} }));
}
// Pretty JSON for a side-by-side diff: the same content, ignore rules and numeric lexemes as compareCaptures. Object
// keys and header names are sorted so that reordered fields line up; arrays keep their order.
function formatNode(node, path, fields, depth, sortKeys = true) {
  const pad = '  '.repeat(depth + 1), close = '  '.repeat(depth);
  if (!node.children.length) return node.open === '{' ? '{}' : node.open === '[' ? '[]' : node.raw;
  const occurrences = new Map(), entries = [];
  for (const { key, node: child } of node.children) {
    const count = occurrences.get(key) || 0; occurrences.set(key, count + 1);
    const next = childPath(path, key) + (count ? `#${count + 1}` : '');
    if (!ignored(fields, key, next)) entries.push({ key, text: formatNode(child, next, fields, depth + 1, sortKeys) });
  }
  if (node.open === '[') return entries.length ? `[\n${entries.map(entry => pad + entry.text).join(',\n')}\n${close}]` : '[]';
  if (sortKeys) entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return entries.length ? `{\n${entries.map(entry => `${pad}${JSON.stringify(entry.key)}: ${entry.text}`).join(',\n')}\n${close}}` : '{}';
}
function formatBody(text, path, fields, depth) {
  try { return formatNode(parse(String(text)), path, fields, depth); } catch { return JSON.stringify(String(text)); }
}
function formatObject(entries, depth) {
  const pad = '  '.repeat(depth + 1);
  return entries.length ? `{\n${entries.map(([key, text]) => `${pad}${JSON.stringify(key)}: ${text}`).join(',\n')}\n${'  '.repeat(depth)}}` : '{}';
}
// Pretty-prints JSON text for editing, keeping key order and exact numeric lexemes; throws on invalid JSON.
export function formatJson(text) { return formatNode(parse(String(text)), '', [], 0, false); }

// "data", "$.data.flights[0]" or the JSON Pointer "/data/flights/0" select part of a body.
export function pathSegments(path) {
  const value = String(path || '').trim();
  if (!value) return [];
  if (value.startsWith('/')) return value.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  return [...value.replace(/^\$\.?/, '').matchAll(/([^.[\]]+)|\[(\d+|"[^"]*"|'[^']*')\]/g)].map(match => match[1] ?? match[2].replace(/^["']|["']$/g, ''));
}
function selectText(text, segments) {
  let tree;
  try { tree = parse(String(text)); } catch { return undefined; }
  let node = tree;
  for (const segment of segments) { const child = node.children.find(item => item.key === segment); if (!child) return undefined; node = child.node; }
  return String(text).slice(node.start, node.end);
}

export function comparisonText(record, options = {}) {
  const fields = options.ignoreFields || [], section = options.section || 'response';
  if (options.bodyOnly) return formatBody(record.response?.body ?? '', '/body', fields, 0);
  if (section === 'events') {
    const events = (record.events || []).map((event, index) => {
      const key = options.eventKey === 'id' ? event.id ?? `missing-${index}` : event.sequence ?? index, path = childPath('/events', key) + '/0', entries = [];
      for (const field of ['sequence', 'event', 'id', 'retry']) if (event[field] !== undefined && !ignored(fields, field, childPath(path, field))) entries.push([field, JSON.stringify(event[field])]);
      if (event.data !== undefined && !ignored(fields, 'data', `${path}/data`)) entries.push(['data', formatBody(event.data, `${path}/data`, fields, 2)]);
      return `  ${formatObject(entries, 1)}`;
    });
    return events.length ? `[\n${events.join(',\n')}\n]` : '[]';
  }
  const message = record[section] || {}, entries = [];
  for (const field of section === 'request' ? ['method', 'url'] : ['statusCode', 'reason']) {
    const value = message[field] ?? (section === 'request' ? record[field] : undefined);
    if (value !== undefined && !ignored(fields, field, `/${section}/${field}`)) entries.push([field, JSON.stringify(value)]);
  }
  const names = new Map(), lowerFields = fields.map(field => field.toLowerCase());
  for (const [key, text] of Array.isArray(message.headers) ? message.headers : Object.entries(message.headers || {})) {
    const lower = String(key).toLowerCase(), list = names.get(lower) || [];
    if (!ignored(lowerFields, lower, `${childPath(`/${section}/headers`, lower)}/${list.length}`)) list.push(String(text));
    names.set(lower, list);
  }
  const headers = [...names].filter(([, values]) => values.length).sort(([a], [b]) => a < b ? -1 : 1).map(([name, values]) => [name, values.length === 1 ? JSON.stringify(values[0]) : `[${values.map(value => JSON.stringify(value)).join(', ')}]`]);
  if (!ignored(fields, 'headers', `/${section}/headers`)) entries.push(['headers', formatObject(headers, 1)]);
  if (message.bodyUnavailable) entries.push(['body', JSON.stringify('(body not retained)')]);
  else if (message.body !== undefined && message.body !== '' && !ignored(fields, 'body', `/${section}/body`)) entries.push(['body', formatBody(message.body, `/${section}/body`, fields, 1)]);
  return formatObject(entries, 0);
}

// Custom JSON (pasted or from the clipboard) has no headers or status, so a comparison that includes it compares bodies:
// the capture's request or response body, or its SSE event data as one JSON array. `record.custom` holds the pasted text.
export function bodyRecord(record, section = 'response', focusPath = '') {
  const segments = pathSegments(focusPath), missing = JSON.stringify('(path not found)');
  const focus = text => segments.length ? selectText(text, segments) ?? missing : text;
  if (typeof record?.custom === 'string') return { state: 'complete', response: { body: focus(record.custom) } };
  let text;
  if (section === 'events') text = `[${(record.events || []).map(event => { const data = event.data; if (typeof data !== 'string') return JSON.stringify(data ?? null); try { parse(data); return focus(data); } catch { return segments.length ? missing : JSON.stringify(data); } }).join(',')}]`;
  else text = focus(record[section]?.body ?? '');
  return { state: incomplete(record, section) ? 'partial' : 'complete', response: { body: text, bodyUnavailable: record[section]?.bodyUnavailable } };
}

export function compareCaptures(left, right, options = {}) {
  if (!withinComparisonBudget(left, right, options.section || 'response')) return {
    changes: [], totalChanges: 0, limited: true, incomplete: true,
    warnings: ['Comparison not evaluated: retained source text exceeds the 80 MiB comparison budget. Choose smaller captures.'],
  };
  const a = captureMap(left, options); const b = captureMap(right, options); const changes = []; let totalChanges = 0;
  for (const path of new Set([...a.keys(), ...b.keys()])) if (a.get(path) !== b.get(path)) {
    totalChanges++; if (changes.length < 500) changes.push({ path, ...(a.has(path) ? { before: a.get(path) } : {}), ...(b.has(path) ? { after: b.get(path) } : {}) });
  }
  const partial = incomplete(left, options.section || 'response') || incomplete(right, options.section || 'response');
  return { changes, totalChanges, incomplete: partial, warnings: partial ? ['At least one capture is incomplete; matching retained content does not establish equality.'] : [] };
}
function redactJson(text, fields) {
  const tree = parse(text); const ranges = [];
  function visit(node, path) { for (const { key, node: child } of node.children) { const next = childPath(path, key); if (ignored(fields, key.toLowerCase(), next.toLowerCase())) ranges.push({ start: child.start, end: child.end }); else visit(child, next); } }
  visit(tree, ''); let result = text;
  for (const range of ranges.sort((a, b) => b.start - a.start)) result = result.slice(0, range.start) + '"[REDACTED]"' + result.slice(range.end);
  return result;
}
export function redactCapture(record, { fields = [] } = {}) {
  const names = [...sensitive, ...fields.map(field => field.toLowerCase())]; const warnings = new Set();
  function url(value) {
    try { const parsed = new URL(value); if (parsed.username) parsed.username = '[REDACTED]'; if (parsed.password) parsed.password = '[REDACTED]';
      for (const key of new Set(parsed.searchParams.keys())) if (names.includes(key.toLowerCase())) { const count = parsed.searchParams.getAll(key).length; parsed.searchParams.delete(key); for (let i = 0; i < count; i++) parsed.searchParams.append(key, '[REDACTED]'); }
      parsed.hash = ''; return parsed.href;
    } catch { warnings.add('An invalid URL was omitted.'); return '[URL OMITTED]'; }
  }
  function walk(value, key = '') {
    if (names.includes(key.toLowerCase())) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(item => walk(item));
    if (!value || typeof value !== 'object') return value;
    const result = Object.create(null);
    for (const [field, content] of Object.entries(value)) {
      if (/base64|raw|logs?|bytes|preview|decoded|payload|wire|hex/i.test(field)) continue;
      if (field === 'headers') result[field] = Array.isArray(content) ? content.map(([name, text]) => [name, names.includes(String(name).toLowerCase()) ? '[REDACTED]' : text]) : Object.fromEntries(Object.entries(content || {}).map(([name, text]) => [name, names.includes(name.toLowerCase()) ? '[REDACTED]' : text]));
      else if (field.toLowerCase() === 'url') result[field] = url(content);
      else if (field === 'body' || field === 'data' && typeof content === 'string') {
        if (typeof content === 'string' && sourceBytes(content) > SOURCE_BUDGET) {
          result[field] = '[LARGE CONTENT OMITTED]'; warnings.add('Content exceeding the 4 MiB redaction budget was omitted.'); continue;
        }
        try { result[field] = redactJson(String(content), names); }
        catch { result[field] = '[NON-JSON CONTENT OMITTED]'; warnings.add('Non-JSON or malformed content was omitted because field redaction cannot be guaranteed.'); }
      } else result[field] = walk(content, field);
    }
    return result;
  }
  const sanitized = walk(record); sanitized.redactionWarnings = [...warnings]; return sanitized;
}

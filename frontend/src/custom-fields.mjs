// Custom fields: engine-validated config, engine-extracted values (row.fields); these helpers only label and arrange them.
export const fieldSources = [
  {id: 'response', label: 'Response body', kind: 'json', tab: 'response'},
  {id: 'request', label: 'Request body', kind: 'json', tab: 'request'},
  {id: 'event', label: 'SSE events', kind: 'json', tab: 'events'},
  {id: 'responseHeader', label: 'Response header', kind: 'header', tab: 'response'},
  {id: 'requestHeader', label: 'Request header', kind: 'header', tab: 'request'},
];
const sourceById = Object.fromEntries(fieldSources.map(source => [source.id, source]));
export const sourceLabel = id => sourceById[id]?.label ?? id;
export const isHeaderSource = id => sourceById[id]?.kind === 'header';

// The engine matches with Python fnmatch: escape its metacharacters, drop the query, and match anything after the path.
export function urlWildcard(url) {
  let base = url;
  try { const parsed = new URL(url); base = parsed.origin + parsed.pathname; } catch { base = String(url).split(/[?#]/)[0]; }
  return base.replace(/[[\]*?]/g, char => `[${char}]`) + '*';
}

const DEFAULT_LOCATION = {pattern: '*', method: '*', source: 'response', path: '$.data'};
export function newLocation(patch = {}) { return {...DEFAULT_LOCATION, ...patch}; }
export function newField(patch = {}, location = {}) {
  return {id: crypto.randomUUID(), name: 'New field', locations: [newLocation(location)], ...patch};
}
export const isDefaultLocation = location => Object.entries(DEFAULT_LOCATION).every(([key, value]) => location[key] === value);

// Switching between a body source and a header source keeps the path only when it still fits the new kind.
export function changeSource(location, source) {
  const header = isHeaderSource(source);
  const fits = header ? !location.path.startsWith('$') : location.path.startsWith('$');
  return {...location, source, path: fits ? location.path : header ? '' : '$.'};
}

// Python fnmatch.fnmatchcase, as the engine matches: * any run, ? one character, [seq] / [!seq] a set.
export function wildcardMatches(pattern, text) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      // As in fnmatch, a ] right after [ or [! is part of the set.
      let start = index + 1;
      if (pattern[start] === '!') start++;
      if (pattern[start] === ']') start++;
      const end = pattern.indexOf(']', start);
      if (end < 0) { source += '\\['; continue; }
      let set = pattern.slice(index + 1, end), negate = '';
      if (set.startsWith('!')) { negate = '^'; set = set.slice(1); }
      source += `[${negate}${set.replace(/[\\\]^[]/g, '\\$&')}]`;
      index = end;
    } else source += char.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`, 's').test(text); } catch { return false; }
}
export function locationMatches(location, record) {
  return !!record && (location.method === '*' || location.method.toUpperCase() === String(record.method).toUpperCase()) && wildcardMatches(location.pattern, record.url ?? '');
}

/** Where a value picked from a capture goes in the active field: into the active location when it reads this API (or
 * is still the untouched default), otherwise into a new location for the capture's API. */
export function pickInto(field, active, record, source, path) {
  const current = field.locations[active];
  const named = field.name === 'New field' ? {name: fieldName(path)} : {};
  if (current && (isDefaultLocation(current) || locationMatches(current, record))) {
    const scoped = isDefaultLocation(current) && record ? {pattern: urlWildcard(record.url), method: record.method} : {};
    return {field: {...field, ...named, locations: field.locations.map((location, index) => index === active ? {...location, ...scoped, source, path} : location)}, index: active, added: false};
  }
  if (field.locations.length >= 10) return null;
  const location = newLocation({pattern: urlWildcard(record.url), method: record.method, source, path});
  return {field: {...field, ...named, locations: [...field.locations, location]}, index: field.locations.length, added: true};
}

export function locationText(location) {
  return `${sourceLabel(location.source)} · ${location.path}`;
}

// Defaults the field name from the last JSONPath step or the header name.
export function fieldName(path) {
  const text = String(path);
  if (!text.startsWith('$')) return text || 'New field';
  const steps = [...text.matchAll(/\.([^.[\]]+)|\["((?:[^"\\]|\\.)*)"\]|\['([^']*)'\]/g)].map(match => match[1] ?? match[2] ?? match[3]).filter(step => step !== '*');
  return steps.pop() || 'New field';
}

export function fieldChips(fields) {
  return (fields ?? []).filter(field => field.state === 'found' && field.values?.length)
    .map(field => ({id: field.id, name: field.name, value: field.summaries?.[0] ?? field.values[0], full: field.values[0], more: Math.max(0, field.count - 1), limited: field.limited}));
}

export function chipText(chip) {
  return `${chip.name}=${chip.value}${chip.more ? ` +${chip.more}${chip.limited ? '+' : ''}` : ''}`;
}

export function chipTitle(chip) {
  return `${chip.name}=${chip.full}${chip.more ? ` (+${chip.more}${chip.limited ? '+' : ''} more)` : ''}`;
}

// Row values are cut at 256 characters and arrays/objects only summarized, so the inspector asks for full values.
export function needsFullValues(fields) {
  return (fields ?? []).some(field => field.state === 'found' && (field.limited || field.summaries?.some(Boolean)));
}

// Pretty JSON for an array or object value; null when the text is not complete JSON (cut at the engine's cap).
export function prettyValue(value) {
  try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : null; } catch { return null; }
}

export function fieldsColumnValue(fields) {
  const chips = fieldChips(fields);
  return chips.length ? chips.map(chipText).join(' ') : undefined;
}

export function fieldsForTab(fields, tab) {
  if (tab === 'overview') return fields ?? [];
  return (fields ?? []).filter(field => field.locations?.some(location => sourceById[location.source]?.tab === tab));
}

export function stateText(field) {
  if (field.state === 'pending') return 'Waiting for content';
  if (field.state === 'unknown') return field.note || 'Content is unavailable';
  if (field.state === 'missing') return 'Not found';
  return '';
}

// Reordering by drag or keyboard: move one field before or after another; the order is the chip and inspector order.
export function moveField(fields, id, targetId, after) {
  const moving = fields.find(field => field.id === id);
  if (!moving || id === targetId) return fields;
  const rest = fields.filter(field => field.id !== id);
  const index = rest.findIndex(field => field.id === targetId);
  if (index < 0) return fields;
  rest.splice(index + (after ? 1 : 0), 0, moving);
  return rest;
}
export function moveFieldBy(fields, id, step) {
  const index = fields.findIndex(field => field.id === id), target = fields[index + step];
  return index < 0 || !target ? fields : moveField(fields, id, target.id, step > 0);
}

// Per-field saves merge into the engine's latest list, so a field added or edited elsewhere (another window, an MCP
// agent) is kept. placeField puts one edited field where it sits in the local order; orderLike applies a local order.
export function placeField(serverFields, localFields, field) {
  const rest = serverFields.filter(item => item.id !== field.id);
  const at = localFields.findIndex(item => item.id === field.id);
  if (at < 0) return [...rest, field];
  for (let index = at - 1; index >= 0; index--) {
    const before = rest.findIndex(item => item.id === localFields[index].id);
    if (before >= 0) { rest.splice(before + 1, 0, field); return rest; }
  }
  return [field, ...rest];
}
export function orderLike(serverFields, localFields) {
  const rank = new Map(localFields.map((field, index) => [field.id, index]));
  return serverFields.map((field, index) => ({field, index})).sort((a, b) => (rank.get(a.field.id) ?? Infinity) - (rank.get(b.field.id) ?? Infinity) || a.index - b.index).map(item => item.field);
}

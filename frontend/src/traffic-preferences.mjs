export const columnIds = ['method','request','time','status','duration','serverTime','protocol','device','application','host','path','events'];
export const defaultColumns = ['method','request','status','duration'];
export function readColumns(raw) {
  try {
    const value = JSON.parse(raw ?? 'null');
    const columns = Array.isArray(value) ? [...new Set(value.filter(id => columnIds.includes(id)))] : [];
    return columns.length ? columns : defaultColumns;
  } catch { return defaultColumns; }
}
// Column widths the user dragged, in CSS pixels; unknown columns and out-of-range values are dropped.
export const columnWidthsKey = 'streamglass.columnWidths.v1';
export const MIN_COLUMN = 48, MAX_COLUMN = 900;
export function readColumnWidths(raw) {
  try {
    const value = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, width]) => columnIds.includes(id) && Number.isFinite(width) && width >= MIN_COLUMN && width <= MAX_COLUMN).map(([id, width]) => [id, Math.round(width)]));
  } catch { return {}; }
}
export function isSSE(record) {
  if (record.kind === 'tunnel') return false;
  const headers = record.response?.headers ?? {};
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return record.isSSE === true || (record.eventCount ?? record.events?.length ?? 0) > 0 || entries.some(([name, value]) => String(name).toLowerCase() === 'content-type' && String(value).toLowerCase().includes('text/event-stream'));
}
export function matchesLibrary(record, library) {
  if (library === 'pinned') return record.pinned === true;
  if (library === 'sse') return isSSE(record);
  return true;
}
export function matchesQuickFilters(record, protocols, statuses) {
  const protocol = record.kind === 'tunnel' || record.url.toLowerCase().startsWith('https:') ? 'HTTPS' : 'HTTP';
  return (!protocols.length || protocols.includes(protocol) || protocols.includes('SSE') && isSSE(record)) && (!statuses.length || record.kind !== 'tunnel' && statuses.includes(Math.floor((record.status ?? record.statusCode ?? 0) / 100)));
}

export const columnIds = ['method','request','time','status','duration','serverTime','protocol','device','application','host','path','events','fields'];
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
export const contentTypes = ['json', 'form', 'xml', 'js', 'css', 'document', 'media', 'other'];
export const contentTypeLabels = {json: 'JSON', form: 'Form', xml: 'XML', js: 'JS', css: 'CSS', document: 'Document', media: 'Media', other: 'Other'};
function mimeType(record, direction) {
  const summary = record[`${direction}ContentType`];
  if (typeof summary === 'string') return summary.split(';', 1)[0].trim().toLowerCase();
  const headers = record[direction]?.headers ?? {};
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return String(entries.find(([name]) => String(name).toLowerCase() === 'content-type')?.[1] ?? '').split(';', 1)[0].trim().toLowerCase();
}
function classifyMime(mime) {
  if (/^(image|audio|video)\//.test(mime) || mime === 'application/ogg') return 'media';
  if (['application/x-www-form-urlencoded', 'multipart/form-data'].includes(mime)) return 'form';
  if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'document';
  if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml';
  if (mime === 'text/css') return 'css';
  if (/^(application|text)\/(x-)?(javascript|ecmascript)$/.test(mime)) return 'js';
  if (mime.startsWith('text/') && mime !== 'text/event-stream' || ['application/pdf', 'application/rtf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(mime) || mime.startsWith('application/vnd.openxmlformats-officedocument.') || mime.startsWith('application/vnd.oasis.opendocument.')) return 'document';
  return 'other';
}
export function recordContentTypes(record) {
  if (record.kind === 'tunnel' || record.isEncrypted) return [];
  const request = mimeType(record, 'request'), response = mimeType(record, 'response');
  const types = [classifyMime(response || request)];
  if (isSSE(record)) {
    // Summary rows carry a small derived flag; full records can classify their retained events.
    const hasJsonEvents = record.hasJsonEvents ?? (record.events ?? []).some(event => {
      if (typeof event?.data !== 'string' || !event.data || event.data.length > 1024 * 1024) return false;
      try { JSON.parse(event.data); return true; } catch { return false; }
    });
    if (hasJsonEvents && !types.includes('json')) {
      if (types[0] === 'other') types[0] = 'json';
      else types.push('json');
    }
  }
  // A submitted form can also have a JSON/XML response: either filter should find it.
  if (classifyMime(request) === 'form' && !types.includes('form')) types.push('form');
  return types;
}
export function matchesQuickFilters(record, protocols, statuses, types = []) {
  const protocol = record.kind === 'tunnel' || record.url.toLowerCase().startsWith('https:') ? 'HTTPS' : 'HTTP';
  return (!protocols.length || protocols.includes(protocol) || protocols.includes('SSE') && isSSE(record)) && (!statuses.length || record.kind !== 'tunnel' && statuses.includes(Math.floor((record.status ?? record.statusCode ?? 0) / 100))) && (!types.length || recordContentTypes(record).some(type => types.includes(type)));
}

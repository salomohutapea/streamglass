// Pure helpers that turn captured HTTP messages into display structures. Read-only; never mutates input.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const TEXT_PREVIEW_LIMIT = 2048;

export function headerValues(headers, name) {
  const wanted = String(name).toLowerCase();
  return (Array.isArray(headers) ? headers : []).filter(pair => Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted).map(pair => String(pair[1] ?? ''));
}

export function headerValue(headers, name) {
  return headerValues(headers, name)[0];
}

export function mediaType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

export function decodeComponent(text) {
  const value = String(text).replace(/\+/g, ' ');
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseUrlEncoded(text) {
  return String(text ?? '').split('&').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? { name: decodeComponent(part), value: '' } : { name: decodeComponent(part.slice(0, index)), value: decodeComponent(part.slice(index + 1)) };
  });
}

export function parseQuery(url) {
  const text = String(url ?? '');
  const start = text.indexOf('?');
  if (start < 0) return [];
  const hash = text.indexOf('#', start);
  return parseUrlEncoded(text.slice(start + 1, hash < 0 ? undefined : hash));
}

export function parseCookies(header) {
  return String(header ?? '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? { name: part, value: '' } : { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
  });
}

export function parseSetCookie(values) {
  return (Array.isArray(values) ? values : [values]).filter(value => typeof value === 'string' && value.trim()).map(value => {
    const [first, ...rest] = value.split(';');
    const index = first.indexOf('=');
    const attributes = rest.map(part => part.trim()).filter(Boolean).map(part => {
      const at = part.indexOf('=');
      return at < 0 ? { name: part, value: '' } : { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim() };
    });
    const find = key => attributes.find(item => item.name.toLowerCase() === key)?.value;
    return {
      name: (index < 0 ? '' : first.slice(0, index)).trim(), value: (index < 0 ? first : first.slice(index + 1)).trim(),
      domain: find('domain') ?? '', path: find('path') ?? '', expires: find('expires') ?? find('max-age') ?? '',
      flags: attributes.filter(item => ['secure', 'httponly', 'partitioned'].includes(item.name.toLowerCase())).map(item => item.name).concat(find('samesite') ? [`SameSite=${find('samesite')}`] : []),
    };
  });
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''));
  return match ? (match[1] ?? match[2]) : '';
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function isTextual(type) {
  return type.startsWith('text/') || /json|xml|javascript|x-www-form-urlencoded|html/.test(type) || type === '';
}

// Parses a multipart body into parts; unknown/broken input yields whatever parts could be read.
export function parseMultipart(contentType, bodyBase64, limit = TEXT_PREVIEW_LIMIT) {
  const boundary = multipartBoundary(contentType);
  if (!boundary || !bodyBase64) return [];
  let bytes;
  try { bytes = base64ToBytes(bodyBase64); } catch { return []; }
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: false });
  const delimiter = encoder.encode('--' + boundary), crlf2 = encoder.encode('\r\n\r\n'), lf2 = encoder.encode('\n\n');
  const parts = [];
  let position = indexOfBytes(bytes, delimiter);
  while (position >= 0) {
    let start = position + delimiter.length;
    if (bytes[start] === 45 && bytes[start + 1] === 45) break;
    if (bytes[start] === 13) start++;
    if (bytes[start] === 10) start++;
    const next = indexOfBytes(bytes, delimiter, start);
    if (next < 0) break;
    let end = next;
    if (bytes[end - 1] === 10) end--;
    if (bytes[end - 1] === 13) end--;
    const section = bytes.subarray(start, Math.max(start, end));
    let split = indexOfBytes(section, crlf2), gap = 4;
    if (split < 0) { split = indexOfBytes(section, lf2); gap = 2; }
    const headerText = decoder.decode(split < 0 ? section : section.subarray(0, split));
    const content = split < 0 ? new Uint8Array(0) : section.subarray(split + gap);
    const headers = headerText.split(/\r?\n/).filter(Boolean).map(line => { const at = line.indexOf(':'); return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()]; });
    const disposition = headerValue(headers, 'content-disposition') ?? '';
    const param = key => { const m = new RegExp(`(?:^|;)\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i').exec(disposition); return m ? (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1').trim() : ''; };
    const type = headerValue(headers, 'content-type') ?? '';
    const filename = param('filename');
    parts.push({
      name: param('name'), filename, contentType: type, size: content.length,
      text: isTextual(mediaType(type)) && !(filename && !type) ? decoder.decode(content.subarray(0, limit)) : undefined,
      truncated: content.length > limit,
    });
    position = next;
  }
  return parts;
}

export function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function imageDataUrl(headers, bodyBase64) {
  const type = mediaType(headerValue(headers, 'content-type'));
  if (!IMAGE_TYPES.has(type) || !bodyBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64)) return '';
  return `data:${type};base64,${bodyBase64}`;
}

// Describes the structured sections available for a request message.
export function requestStructure(request) {
  const type = mediaType(headerValue(request?.headers, 'content-type'));
  const result = { query: parseQuery(request?.url), cookies: parseCookies(headerValues(request?.headers, 'cookie').join('; ')), form: [], parts: [] };
  if (type === 'application/x-www-form-urlencoded') result.form = parseUrlEncoded(request?.body ?? '');
  else if (type === 'multipart/form-data') result.parts = parseMultipart(headerValue(request?.headers, 'content-type'), request?.bodyBase64);
  return result;
}

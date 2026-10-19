export function encodeReplayText(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Request body exceeds 8 MiB');
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(parts.join(''));
}
export function decodeReplayText(base64) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Request body exceeds 8 MiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function replayHeaders(headers, textChanged) {
  if (!Array.isArray(headers) || headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string'))) throw new Error('Request headers must be [name, value] pairs');
  // Edited text is uncompressed; unchanged/base64 bodies retain their explicit encoding.
  return textChanged ? headers.filter(([name]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) : headers;
}

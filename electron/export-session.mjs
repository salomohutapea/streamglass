import { createWriteStream, createReadStream } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function exportSession({ baseUrl, token, destination, sessionId }) {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))) throw new Error('Invalid session ID');
  const response = await fetch(new URL(sessionId ? `/api/sessions/${sessionId}/export` : '/api/export-all', baseUrl), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000), redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error(`Could not export captures (HTTP ${response.status}).`);
  const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function importSession({ baseUrl, token, source }) {
  const size = (await stat(source)).size;
  const maximum = 256 * 1024 * 1024 + 65536;
  if (!size || size > maximum) throw new Error('Choose a .sgsession file with at most 256 MiB of captures');
  const stream = createReadStream(source);
  async function* chunks() {
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error('Session file exceeds 256 MiB plus metadata');
      yield chunk;
    }
  }
  try {
    const response = await fetch(new URL('/api/sessions/import', baseUrl), {
      method: 'POST', redirect: 'error', duplex: 'half',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
      body: chunks(), signal: AbortSignal.timeout(180000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? `Session import failed (HTTP ${response.status})`);
    return value;
  } finally { stream.destroy(); }
}

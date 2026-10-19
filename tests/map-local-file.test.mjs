import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_MAP_LOCAL_FILE_BYTES, readMapLocalFile } from '../electron/map-local-file.mjs';

test('chosen response file returns bytes and basename only, rejects oversized/non-files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'streamglass-map-'));
  try {
    const file = path.join(directory, 'response.bin');
    await writeFile(file, Buffer.from([0, 255, 1]));
    assert.deepEqual(await readMapLocalFile(file), { fileName: 'response.bin', bodyBase64: 'AP8B' });
    await truncate(file, MAX_MAP_LOCAL_FILE_BYTES + 1);
    await assert.rejects(readMapLocalFile(file), /32 MiB/);
    await assert.rejects(readMapLocalFile(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

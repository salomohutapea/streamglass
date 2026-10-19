import { open } from 'node:fs/promises';
import path from 'node:path';

export const MAX_MAP_LOCAL_FILE_BYTES = 32 * 1024 * 1024;

// The main process supplies only a path returned by its native file chooser.
export async function readMapLocalFile(filePath) {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_MAP_LOCAL_FILE_BYTES) throw new Error('Choose a regular file no larger than 32 MiB');
    const buffer = Buffer.alloc(MAX_MAP_LOCAL_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_MAP_LOCAL_FILE_BYTES) throw new Error('File exceeds 32 MiB');
    return { fileName: path.basename(filePath), bodyBase64: buffer.subarray(0, size).toString('base64') };
  } finally { await file.close(); }
}

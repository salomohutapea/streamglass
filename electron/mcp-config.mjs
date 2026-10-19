import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';

export async function loadMcpConfig(file) {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (typeof config.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid MCP configuration');
    await chmod(file, 0o600);
    return config;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const config = { enabled: true, token: randomBytes(32).toString('hex') };
    await writeFile(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    return config;
  }
}

export async function saveMcpConfig(file, config) {
  await writeFile(file + '.tmp', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

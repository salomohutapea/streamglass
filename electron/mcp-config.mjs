import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';

const MAX_APPROVED = 200;
const target = value => typeof value === 'string' && value.length <= 300 && /^https?:\/\/[^\s/]+:\d{1,5}$/.test(value);

// MCP starts disabled. Older installations may keep their previous server approvals as display-only metadata.
export async function loadMcpConfig(file) {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (typeof config.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid MCP configuration');
    const approvedRedirects = config.approvedRedirects ?? [];
    if (!Array.isArray(approvedRedirects) || approvedRedirects.length > MAX_APPROVED || !approvedRedirects.every(target)) throw new Error('Invalid MCP configuration');
    await chmod(file, 0o600);
    return { ...config, approvedRedirects };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const config = { enabled: false, token: randomBytes(32).toString('hex'), approvedRedirects: [] };
    await writeFile(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    return config;
  }
}

export async function saveMcpConfig(file, config) {
  await writeFile(file + '.tmp', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMcpConfig, saveMcpConfig } from '../electron/mcp-config.mjs';

test('MCP credentials survive restart with private permissions and persisted disable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'streamglass-mcp-config-'));
  try {
    const file = path.join(dir, 'mcp.json');
    const first = await loadMcpConfig(file);
    assert.equal(first.enabled, true);
    assert.match(first.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(await loadMcpConfig(file), first);
    await saveMcpConfig(file, { ...first, enabled: false });
    assert.deepEqual(await loadMcpConfig(file), { ...first, enabled: false });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, '{}');
    await assert.rejects(loadMcpConfig(file), /Invalid MCP configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

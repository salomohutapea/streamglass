import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approveRedirects, loadMcpConfig, saveMcpConfig } from '../electron/mcp-config.mjs';

test('MCP starts disabled and credentials survive restart with private permissions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'streamglass-mcp-config-'));
  try {
    const file = path.join(dir, 'mcp.json');
    const first = await loadMcpConfig(file);
    assert.equal(first.enabled, false);
    assert.deepEqual(first.approvedRedirects, []);
    assert.match(first.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(await loadMcpConfig(file), first);
    await saveMcpConfig(file, { ...first, enabled: true });
    assert.deepEqual(await loadMcpConfig(file), { ...first, enabled: true });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, JSON.stringify({ enabled: true, token: first.token }));
    assert.deepEqual((await loadMcpConfig(file)).approvedRedirects, []);
    await writeFile(file, JSON.stringify({ enabled: true, token: first.token, approvedRedirects: ['javascript:alert(1)'] }));
    await assert.rejects(loadMcpConfig(file), /Invalid MCP configuration/);
    await writeFile(file, '{}');
    await assert.rejects(loadMcpConfig(file), /Invalid MCP configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approved redirect servers are deduplicated and validated', () => {
  const config = { enabled: true, token: 'a'.repeat(64), approvedRedirects: ['https://staging.example.test:443'] };
  assert.deepEqual(approveRedirects(config, ['https://staging.example.test:443', 'http://qa.example.test:8080', 'bad']).approvedRedirects,
    ['https://staging.example.test:443', 'http://qa.example.test:8080']);
  assert.throws(() => approveRedirects({ ...config, approvedRedirects: Array.from({ length: 200 }, (_, i) => `https://h${i}.example.test:443`) }, ['https://new.example.test:443']), /At most 200/);
});

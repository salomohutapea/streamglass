import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../electron/workspaces.mjs';

test('workspaces preserve unsaved configuration, exclude runtime settings, and reload from disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-workspaces-'));
  try {
    let current = { tlsDomains: ['one.example'], rules: [], folders: [], trafficTools: {}, scenarios: { rules: [] }, proxyEnabled: true, token: 'secret' };
    const options = { file: path.join(directory, 'workspaces.json'), readConfig: async () => current, applyConfig: async value => { current = value; } };
    const service = await createWorkspaceService(options);
    const first = await service.save({ name: 'One' }); const one = first.activeId;
    current = { ...current, tlsDomains: ['two.example'] };
    const second = await service.save({ name: 'Two' }); const two = second.activeId;
    current = { ...current, tlsDomains: ['unsaved.example'] };
    await service.load({ id: one }); assert.deepEqual(current.tlsDomains, ['one.example']);
    await service.load({ id: two }); assert.deepEqual(current.tlsDomains, ['unsaved.example']);
    const disk = await readFile(options.file, 'utf8'); assert.equal(disk.includes('secret'), false); assert.equal(disk.includes('proxyEnabled'), false);
    assert.equal((await (await createWorkspaceService(options)).list()).activeId, two);
    await assert.rejects(service.rename({ id: one, name: '' }));
    await service.rename({ id: one, name: 'Renamed' }); await service.delete({ id: one });
    assert.equal((await service.list()).workspaces.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed apply leaves saved workspaces and current selection unchanged', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-workspaces-'));
  try {
    let current = { tlsDomains: ['one.example'] };
    const service = await createWorkspaceService({ file: path.join(directory, 'workspaces.json'), readConfig: async () => current, applyConfig: async () => { throw new Error('Invalid configuration'); } });
    const first = await service.save({ name: 'One' });
    current = { tlsDomains: ['two.example'] }; await service.save({ name: 'Two' });
    const before = await service.list();
    await assert.rejects(service.load({ id: first.activeId }), /Invalid configuration/);
    assert.deepEqual(await service.list(), before);
    assert.deepEqual(current.tlsDomains, ['two.example']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup rejects oversized sparse storage before parsing it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-workspaces-'));
  try {
    const file = path.join(directory, 'workspaces.json');
    await writeFile(file, ''); await truncate(file, 128 * 1024 * 1024 + 1);
    await assert.rejects(createWorkspaceService({ file }), /128 MiB aggregate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('oversized serialized snapshots preserve the previous file and active configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-workspaces-'));
  try {
    const file = path.join(directory, 'workspaces.json');
    let current = { tlsDomains: ['safe.example'] };
    const service = await createWorkspaceService({ file, readConfig: async () => current, applyConfig: async value => { current = value; } });
    await service.save({ name: 'Safe' }); const previous = await readFile(file, 'utf8'); const listing = await service.list();
    // Control characters expand sixfold in JSON; reject before allocating the encoded 138 MiB string.
    current = { tlsDomains: ['current.example'], rules: [{ script: '\0'.repeat(23 * 1024 * 1024) }] };
    await assert.rejects(service.save({ name: 'Too large' }), /128 MiB aggregate/);
    assert.equal(await readFile(file, 'utf8'), previous); assert.deepEqual(await service.list(), listing);
    assert.deepEqual(current.tlsDomains, ['current.example']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dependencyStamp, pruneReleaseFolders, releaseOptions, reserveReleaseFolder, run } from '../scripts/developer-tools.mjs';

test('dependency preparation changes when project metadata or packaging requirements change', () => {
  assert.equal(dependencyStamp('dependencies-a', false), dependencyStamp('dependencies-a', false));
  assert.notEqual(dependencyStamp('dependencies-a', false), dependencyStamp('dependencies-b', false));
  assert.notEqual(dependencyStamp('dependencies-a', false), dependencyStamp('dependencies-a', true));
  assert.notEqual(dependencyStamp('dependencies-a', false, 'pins-a'), dependencyStamp('dependencies-a', false, 'pins-b'));
});

test('local release disables signing and publication and uses a separate output folder', () => {
  const result = releaseOptions({ version: '0.1.0', now: new Date('2026-10-16T00:00:00Z') });
  assert.match(result.folder, /release\/local\/0\.1\.0-2026-10-16T00-00-00-000Z$/);
  assert.ok(result.args.includes('--config.mac.identity=null'));
  assert.ok(result.args.includes('--config.mac.notarize=false'));
  assert.equal(result.args[result.args.indexOf('--publish') + 1], 'never');
  assert.equal(result.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  const signed = releaseOptions({ version: '0.1.0', signed: true });
  assert.ok(!signed.args.includes('--config.mac.identity=null'));
  assert.ok(!signed.args.includes('--config.mac.notarize=false'));
  assert.ok(signed.args.includes('--config.forceCodeSigning=true'));
});

test('release preparation refuses to overwrite an existing destination', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'streamglass-release-'));
  try {
    const output = path.join(temp, 'local', 'release');
    await reserveReleaseFolder(output);
    await writeFile(path.join(output, 'existing.app'), 'existing');
    await assert.rejects(reserveReleaseFolder(output), { code: 'EEXIST' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('command failures stop the pipeline with an actionable error', async () => {
  await run(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), /failed \(7\).*See output above/);
});

test('pruning removes only older release folders next to the kept one', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'streamglass-prune-'));
  try {
    const parent = path.join(temp, 'local');
    const names = ['0.1.0-2026-10-18T09-15-11-279Z', '0.1.0-2026-10-19T02-48-37-536Z', 'notes', 'keep-me.txt'];
    for (const name of names.slice(0, 3)) await mkdir(path.join(parent, name), { recursive: true });
    await writeFile(path.join(parent, names[3]), 'x');
    assert.deepEqual(await pruneReleaseFolders(path.join(parent, names[1])), [names[0]]);
    assert.deepEqual((await readdir(parent)).sort(), [names[1], 'keep-me.txt', 'notes'].sort());
  } finally { await rm(temp, { recursive: true, force: true }); }
});

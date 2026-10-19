import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { applyVersion, nextVersion } from '../scripts/bump-version.mjs';

test('next version supports patch, minor, major, and exact values', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', '3.0.1'), '3.0.1');
  for (const bad of ['', 'big', '1.2', 'v1.2.3', '1.2.3-beta']) assert.throws(() => nextVersion('1.2.3', bad));
  assert.throws(() => nextVersion('1.2', 'patch'));
});

test('applying a version updates package, lockfile root, and pyproject only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-bump-'));
  try {
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2)}\n`);
    await writeFile(path.join(directory, 'package-lock.json'), `${JSON.stringify({ name: 'x', version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/y': { version: '1.0.0' } } }, null, 2)}\n`);
    await writeFile(path.join(directory, 'pyproject.toml'), '[project]\nname = "x"\nversion = "1.0.0"\ndependencies = ["a==1.0.0"]\n');
    await applyVersion(directory, '1.1.0');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version, '1.1.0');
    const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
    assert.deepEqual([lock.version, lock.packages[''].version, lock.packages['node_modules/y'].version], ['1.1.0', '1.1.0', '1.0.0']);
    assert.equal(await readFile(path.join(directory, 'pyproject.toml'), 'utf8'), '[project]\nname = "x"\nversion = "1.1.0"\ndependencies = ["a==1.0.0"]\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const script = new URL('../scripts/uninstall.sh', import.meta.url).pathname;

// Only syntax, help and argument handling run here: the script changes real proxy, keychain and app state.
test('uninstall script parses, documents its options and rejects unknown ones', async () => {
  await run('/bin/bash', ['-n', script]);
  const { stdout } = await run('/bin/bash', [script, '--help']);
  assert.match(stdout, /--keep-app/);
  assert.match(stdout, /--yes/);
  await assert.rejects(run('/bin/bash', [script, '--unknown']), error => error.code === 2);
});

test('uninstall removes only this installation’s CA and never runs as root', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /delete-certificate -Z "\$sha1"/);
  assert.doesNotMatch(source, /delete-certificate -c/);
  assert.match(source, /id -u\)" = "0"/);
});

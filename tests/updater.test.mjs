import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, createUpdateChecker, parseLatestRelease, releasesPrefix } from '../electron/updater.mjs';

test('versions compare numerically and ignore non-release tags', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.1') < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('nightly', '1.0.0'), 0);
});

test('only a newer published release is offered, with a releases-page URL', () => {
  const release = { tag_name: 'v1.1.0', html_url: `${releasesPrefix}tag/v1.1.0` };
  assert.deepEqual(parseLatestRelease(release, '1.0.0'), { version: '1.1.0', url: `${releasesPrefix}tag/v1.1.0` });
  assert.equal(parseLatestRelease(release, '1.1.0'), null);
  assert.equal(parseLatestRelease({ ...release, draft: true }, '1.0.0'), null);
  assert.equal(parseLatestRelease({ ...release, prerelease: true }, '1.0.0'), null);
  assert.equal(parseLatestRelease({ tag_name: 'v2.0.0-beta' }, '1.0.0'), null);
  assert.equal(parseLatestRelease({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x' }, '1.0.0').url, `${releasesPrefix}tag/v1.2.0`);
});

test('checks are cached, failures stay silent, and a failed check retries after ten minutes', async () => {
  let clock = 0, calls = 0, fail = false;
  const check = createUpdateChecker({ currentVersion: '1.0.0', now: () => clock, fetchImpl: async () => { calls++; if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ tag_name: 'v1.0.1' }) }; } });
  assert.equal((await check()).version, '1.0.1');
  await check(); assert.equal(calls, 1);
  clock += 7 * 60 * 60 * 1000; fail = true;
  assert.equal(await check(), null); assert.equal(calls, 2);
  clock += 5 * 60 * 1000; await check(); assert.equal(calls, 2);
  clock += 6 * 60 * 1000; fail = false; assert.equal((await check()).version, '1.0.1'); assert.equal(calls, 3);
});

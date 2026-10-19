import test from 'node:test';
import assert from 'node:assert/strict';
import { appBadge, appBadgeHue, appBadgeInitials } from './app-badge.mjs';

test('initials are the first two characters, uppercase', () => {
  assert.equal(appBadgeInitials('sample-app'), 'SA');
  assert.equal(appBadgeInitials('  x'), 'X');
  assert.equal(appBadgeInitials(''), '?');
});

test('badge colour is stable and bounded', () => {
  assert.deepEqual(appBadge('sample', 'id-1'), appBadge('sample', 'id-1'));
  const hue = appBadgeHue('id-1');
  assert.ok(hue >= 0 && hue < 360);
  assert.match(appBadge('sample', 'id-1').background, /^hsl\(\d+ 48% 36%\)$/);
});

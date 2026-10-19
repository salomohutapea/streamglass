import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertRule } from './rule-order.mjs';

test('editing a rule preserves first-match order; adding a rule appends it', () => {
  const first = { id: 'first', pattern: '*' };
  const second = { id: 'second', pattern: '/api/*' };
  const edited = { ...first, pattern: '/api/search' };
  assert.deepEqual(upsertRule([first, second], edited), [edited, second]);
  assert.deepEqual(upsertRule([first, second], { id: 'third' }), [first, second, { id: 'third' }]);
});

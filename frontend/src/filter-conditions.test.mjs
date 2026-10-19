import test from 'node:test';
import assert from 'node:assert/strict';
import { combineConditionMatches, normalizeExtraConditions, MAX_EXTRA_CONDITIONS } from './filter-conditions.mjs';

const s = (...ids) => new Set(ids);

test('a single condition returns its own matches and none means no filtering', () => {
  assert.deepEqual([...combineConditionMatches([{ filter: 'a' }], [s('1', '2')])], ['1', '2']);
  assert.equal(combineConditionMatches([{ filter: '' }], [s('1')]), null);
});

test('AND intersects and OR unions', () => {
  const c = [{ filter: 'a' }, { joiner: 'and', filter: 'b' }];
  assert.deepEqual([...combineConditionMatches(c, [s('1', '2'), s('2', '3')])], ['2']);
  c[1].joiner = 'or';
  assert.deepEqual([...combineConditionMatches(c, [s('1', '2'), s('2', '3')])].sort(), ['1', '2', '3']);
});

test('AND binds tighter than OR', () => {
  const c = [{ filter: 'a' }, { joiner: 'or', filter: 'b' }, { joiner: 'and', filter: 'c' }];
  // a OR (b AND c)
  assert.deepEqual([...combineConditionMatches(c, [s('1'), s('2', '3'), s('3', '4')])].sort(), ['1', '3']);
});

test('empty conditions are ignored, including an empty first condition', () => {
  const c = [{ filter: '' }, { joiner: 'and', filter: 'b' }, { joiner: 'or', filter: '' }, { joiner: 'or', filter: 'c' }];
  assert.deepEqual([...combineConditionMatches(c, [s('9'), s('1'), s('9'), s('2')])].sort(), ['1', '2']);
});

test('normalize drops malformed entries and caps the count', () => {
  const good = { joiner: 'or', scope: 'response', mode: 'not_contains', filter: 'x' };
  assert.deepEqual(normalizeExtraConditions([good, { scope: 'bad', mode: 'contains', filter: 'x' }, null, 'x']), [good]);
  assert.deepEqual(normalizeExtraConditions(undefined), []);
  assert.equal(normalizeExtraConditions(Array(20).fill(good)).length, MAX_EXTRA_CONDITIONS);
  assert.equal(normalizeExtraConditions([{ ...good, joiner: 'weird' }])[0].joiner, 'and');
});

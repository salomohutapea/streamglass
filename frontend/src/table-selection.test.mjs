import test from 'node:test';
import assert from 'node:assert/strict';
import {toggleId, rangeIds, moveId, pruneIds, clickSelection} from './table-selection.mjs';

const ids = ['a', 'b', 'c', 'd', 'e'];
test('toggle adds and removes without mutating', () => {
  const base = new Set(['a']);
  assert.deepEqual([...toggleId(base, 'b')], ['a', 'b']);
  assert.deepEqual([...toggleId(base, 'a')], []);
  assert.deepEqual([...base], ['a']);
});
test('range works in both directions and with missing anchor', () => {
  assert.deepEqual([...rangeIds(ids, 'b', 'd')], ['b', 'c', 'd']);
  assert.deepEqual([...rangeIds(ids, 'd', 'b')], ['b', 'c', 'd']);
  assert.deepEqual([...rangeIds(ids, 'zz', 'c')], ['c']);
  assert.equal(rangeIds(ids, 'a', 'zz').size, 0);
});
test('move clamps and handles Home/End and unknown current', () => {
  assert.equal(moveId(ids, 'a', 'ArrowUp'), 'a');
  assert.equal(moveId(ids, 'e', 'ArrowDown'), 'e');
  assert.equal(moveId(ids, 'b', 'ArrowDown'), 'c');
  assert.equal(moveId(ids, null, 'ArrowDown'), 'a');
  assert.equal(moveId(ids, null, 'ArrowUp'), 'e');
  assert.equal(moveId(ids, 'c', 'Home'), 'a');
  assert.equal(moveId(ids, 'c', 'End'), 'e');
  assert.equal(moveId([], 'c', 'End'), null);
});
test('prune drops hidden ids and keeps identity when unchanged', () => {
  const s = new Set(['a', 'x']);
  assert.deepEqual([...pruneIds(s, ids)], ['a']);
  const t = new Set(['a']);
  assert.equal(pruneIds(t, ids), t);
});
test('click selection modes', () => {
  assert.deepEqual([...clickSelection({orderedIds: ids, selected: new Set(), anchor: null, id: 'c'}).selected], ['c']);
  const toggled = clickSelection({orderedIds: ids, selected: new Set(['a']), anchor: 'a', id: 'c', toggle: true});
  assert.deepEqual([...toggled.selected], ['a', 'c']);
  assert.equal(toggled.primary, 'c');
  const off = clickSelection({orderedIds: ids, selected: new Set(['a', 'c']), anchor: 'c', id: 'c', toggle: true});
  assert.equal(off.primary, 'a');
  const range = clickSelection({orderedIds: ids, selected: new Set(['b']), anchor: 'b', id: 'd', shift: true});
  assert.deepEqual([...range.selected], ['b', 'c', 'd']);
  assert.equal(range.anchor, 'b');
});

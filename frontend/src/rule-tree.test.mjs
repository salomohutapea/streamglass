import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleRows, dropPlacement, stepPlacement, folderDescendants, folderPath } from './rule-tree.mjs';

const rule = (id, extra = {}) => ({ id, enabled: true, ...extra });
const folders = [{ id: 'F', name: 'Outer' }, { id: 'G', name: 'Inner', parentId: 'F' }];
const rules = [rule('a'), rule('b', { folderId: 'F' }), rule('c', { folderId: 'G', enabled: false }), rule('d')];
const shape = rows => rows.map(row => `${'  '.repeat(row.depth)}${row.type === 'folder' ? `[${row.id}]` : row.id}`);

test('rows follow the tree: folders first by default, contents indented, counts and state rolled up', () => {
  const rows = ruleRows(rules, folders);
  assert.deepEqual(shape(rows), ['[F]', '  [G]', '    c', '  b', 'a', 'd']);
  assert.deepEqual([rows[0].count, rows[0].state, rows[1].count, rows[1].state], [2, 'mixed', 1, 'off']);
  // An empty folder reports its own saved state.
  assert.equal(ruleRows([], [{ id: 'E', name: 'Empty', enabled: false }])[0].state, 'off');
});

test('order places a folder between rules, and a collapsed folder hides its contents but keeps its count', () => {
  const placed = [{ id: 'F', name: 'Outer', order: 1.5, expanded: false }, folders[1]];
  const rows = ruleRows(rules, placed);
  assert.deepEqual(shape(rows), ['a', '[F]', 'd']);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[1].open, false);
});

test('search keeps matching rules with their folders opened and drops empty branches', () => {
  const collapsed = [{ ...folders[0], expanded: false }, folders[1]];
  assert.deepEqual(shape(ruleRows(rules, collapsed, item => item.id === 'c')), ['[F]', '  [G]', '    c']);
  assert.deepEqual(shape(ruleRows(rules, collapsed, item => item.id === 'd')), ['d']);
  assert.deepEqual(ruleRows(rules, collapsed, () => false), []);
});

test('dropping computes the new parent and an order between the neighbours', () => {
  // d before a at the top level: a is first among rules (order 1), folder F sits before it.
  const before = dropPlacement(rules, folders, { type: 'rule', id: 'd' }, { type: 'rule', id: 'a' }, 'before');
  assert.equal(before.parentId, null);
  assert.ok(before.order < 1);
  const moved = rules.map(item => item.id === 'd' ? { ...item, order: before.order } : item);
  assert.deepEqual(shape(ruleRows(moved, folders)).slice(-2), ['d', 'a']);
  // Into a folder appends after its last item; onto a rule inside a folder adopts that folder.
  assert.deepEqual(dropPlacement(rules, folders, { type: 'rule', id: 'a' }, { type: 'folder', id: 'G' }, 'inside').parentId, 'G');
  assert.equal(dropPlacement(rules, folders, { type: 'rule', id: 'a' }, { type: 'rule', id: 'b' }, 'after').parentId, 'F');
  assert.equal(dropPlacement(rules, folders, { type: 'rule', id: 'a' }, { type: 'rule', id: 'b' }, 'inside'), null);
});

test('a folder cannot be dropped into itself or its own contents', () => {
  assert.equal(dropPlacement(rules, folders, { type: 'folder', id: 'F' }, { type: 'folder', id: 'G' }, 'inside'), null);
  assert.equal(dropPlacement(rules, folders, { type: 'folder', id: 'F' }, { type: 'rule', id: 'c' }, 'before'), null);
  assert.equal(dropPlacement(rules, folders, { type: 'folder', id: 'F' }, { type: 'folder', id: 'F' }, 'before'), null);
  // The inner folder can move out to the top level.
  assert.equal(dropPlacement(rules, folders, { type: 'folder', id: 'G' }, { type: 'rule', id: 'd' }, 'after').parentId, null);
  assert.deepEqual([...folderDescendants(folders, 'F')], ['G']);
  assert.equal(folderPath(folders, 'G'), 'Outer / Inner');
});

test('keyboard steps move one place among siblings and stop at the ends', () => {
  const down = stepPlacement(rules, folders, { type: 'rule', id: 'a' }, 1);
  const moved = rules.map(item => item.id === 'a' ? { ...item, order: down.order } : item);
  assert.deepEqual(shape(ruleRows(moved, folders)).slice(-2), ['d', 'a']);
  assert.equal(stepPlacement(rules, folders, { type: 'rule', id: 'd' }, 1), null);
  assert.equal(stepPlacement(rules, folders, { type: 'folder', id: 'F' }, -1), null);
});

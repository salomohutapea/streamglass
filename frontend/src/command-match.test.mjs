import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, filterCommands, pushRecent } from './command-match.mjs';

const commands = [
  { id: 'a', title: 'Open Settings' },
  { id: 'b', title: 'Pause Capture', keywords: 'stop recording' },
  { id: 'c', title: 'Clear all requests' },
  { id: 'd', title: 'Toggle theme' },
];

test('fuzzyScore matches subsequences and rejects misses', () => {
  assert.ok(fuzzyScore('pcap', 'Pause Capture'));
  assert.equal(fuzzyScore('zzz', 'Pause Capture'), null);
  assert.deepEqual(fuzzyScore('', 'x'), { score: 0, indexes: [] });
});

test('substring beats scattered subsequence', () => {
  assert.ok(fuzzyScore('cap', 'Pause Capture').score > fuzzyScore('cpe', 'Pause Capture').score);
});

test('filterCommands ranks, uses keywords and recents', () => {
  assert.equal(filterCommands(commands, 'set')[0].command.id, 'a');
  assert.equal(filterCommands(commands, 'recording')[0].command.id, 'b');
  assert.deepEqual(filterCommands(commands, '', ['d', 'c']).map(r => r.command.id), ['d', 'c', 'a', 'b']);
  assert.equal(filterCommands(commands, 'qqq').length, 0);
});

test('pushRecent dedupes and limits', () => {
  assert.deepEqual(pushRecent(['a', 'b'], 'b'), ['b', 'a']);
  assert.equal(pushRecent(['1', '2', '3'], '4', 3).length, 3);
});

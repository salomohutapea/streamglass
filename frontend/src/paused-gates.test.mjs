import test from 'node:test';
import assert from 'node:assert/strict';
import { endedGates, isDisconnect, pausedEntries, endedConsequence } from './paused-gates.mjs';

const gate = (token, recordId, pausedAt = 1000) => [token, { token, recordId, pausedAt }];

test('a gate cut off while paused is reported with its reason and paused time', () => {
  const seen = new Map([gate('a', 'r1'), gate('b', 'r2'), gate('c', 'r3'), gate('d', 'r4')]);
  const live = new Map([gate('b', 'r2')]);
  const records = [{ id: 'r1', state: 'error', error: 'Peer disconnected while paused' }, { id: 'r3', state: 'pending' }, { id: 'r4', state: 'error', error: 'Dropped by user' }];
  const ended = endedGates(seen, live, new Set(['d']), records, 13000);
  assert.deepEqual(ended.map(item => [item.gate.token, item.reason, item.pausedMs]), [['a', 'Peer disconnected while paused', 12000]]);
});

test('gates resolved elsewhere or released by pause are not reported', () => {
  const seen = new Map([gate('a', 'r1')]);
  assert.deepEqual(endedGates(seen, new Map(), new Set(), [{ id: 'r1', state: 'complete' }]), []);
  assert.deepEqual(endedGates(seen, new Map(), new Set(), []), []);
});

test('only disconnects get the timeout hint', () => {
  assert.equal(isDisconnect('Peer disconnected while paused'), true);
  assert.equal(isDisconnect('Dropped by user'), false);
});

test('an ended gate keeps its place among live gates, oldest pause first', () => {
  const g = (token, pausedAt) => ({ token, pausedAt });
  const entries = pausedEntries([g('a', 1000), g('c', 3000)], [{ gate: g('b', 2000), reason: 'Peer disconnected', pausedMs: 5000 }]);
  assert.deepEqual(entries.map(entry => [entry.gate.token, Boolean(entry.ended)]), [['a', false], ['b', true], ['c', false]]);
  assert.deepEqual(pausedEntries([], []), []);
});

test('the ended warning names what the device misses for each stage', () => {
  assert.match(endedConsequence('request'), /request can no longer be sent/);
  assert.match(endedConsequence('response'), /no longer receive this response/);
  assert.match(endedConsequence('event'), /no longer receive this event/);
});

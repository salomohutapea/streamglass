import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceLabels, trafficDevices, incomingRecordIds } from './device-labels.mjs';

test('device labels retain valid preferences and reject malformed stored data', () => {
  const label = {name:'Pixel',color:'#aabbcc',icon:'android'};
  assert.deepEqual(readDeviceLabels(JSON.stringify({'192.168.1.2':label,bad:{name:3}})), {'192.168.1.2':label});
  for (const invalid of ['broken', 'null', '[]', '{"ip":{"name":"x","color":"red","icon":"mac"}}']) assert.deepEqual(readDeviceLabels(invalid), {});
});

test('platforms come only from captured metadata, with mixed clients left generic', () => {
  assert.deepEqual(trafficDevices([{device:'127.0.0.1'}, {device:'phone',devicePlatform:'ios'}, {device:'phone'}]), [{id:'127.0.0.1',platform:'generic'}, {id:'phone',platform:'ios'}]);
  assert.deepEqual(trafficDevices([{device:'shared',devicePlatform:'ios'}, {device:'shared',devicePlatform:'mac'}]), [{id:'shared',platform:'generic'}]);
});

test('only unseen arrivals highlight, never initial records, reorder, or reappearing old records', () => {
  let state = incomingRecordIds([{id:'old'}], null);
  assert.equal(state.incoming.size, 0);
  state = incomingRecordIds([{id:'new'}, {id:'old'}], state.seen);
  assert.deepEqual([...state.incoming], ['new']);
  state = incomingRecordIds([{id:'old'}, {id:'new'}], state.seen);
  assert.equal(state.incoming.size, 0);
  state = incomingRecordIds([], state.seen);
  assert.equal(incomingRecordIds([{id:'old'}], state.seen).incoming.size, 0);
});

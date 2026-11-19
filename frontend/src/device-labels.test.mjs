import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceLabels, trafficDevices, stableDeviceOrder, incomingRecordIds, isAddressDevice } from './device-labels.mjs';

test('device labels retain valid preferences and reject malformed stored data', () => {
  const label = {name:'Pixel',color:'#aabbcc',icon:'android'};
  assert.deepEqual(readDeviceLabels(JSON.stringify({'192.168.1.2':label,bad:{name:3}})), {'192.168.1.2':label});
  for (const invalid of ['broken', 'null', '[]', '{"ip":{"name":"x","color":"red","icon":"mac"}}']) assert.deepEqual(readDeviceLabels(invalid), {});
});

test('platforms come only from captured metadata, with mixed clients left generic', () => {
  assert.deepEqual(trafficDevices([{device:'127.0.0.1'}, {device:'phone',devicePlatform:'ios'}, {device:'phone'}]), [{id:'127.0.0.1',platform:'generic'}, {id:'phone',platform:'ios'}]);
  assert.deepEqual(trafficDevices([{device:'shared',devicePlatform:'ios'}, {device:'shared',devicePlatform:'mac'}]), [{id:'shared',platform:'generic'}]);
});

test('simulators and emulators on loopback become their own named devices', () => {
  const sim = 'ios-simulator:00000000-0000-4000-8000-000000000001', avd = 'android-emulator:Example_Phone_API_35';
  assert.deepEqual(trafficDevices([
    {device:'127.0.0.1',devicePlatform:'mac'},
    {device:'127.0.0.1',deviceId:sim,deviceName:'iPhone Example (iOS 18.0)',devicePlatform:'ios'},
    {device:'127.0.0.1',deviceId:avd,deviceName:'Example Phone API 35',devicePlatform:'android'},
  ]), [{id:'127.0.0.1',platform:'mac'}, {id:sim,platform:'ios',name:'iPhone Example (iOS 18.0)'}, {id:avd,platform:'android',name:'Example Phone API 35'}]);
  // A name without an engine device id is ignored: addresses are named by reverse DNS.
  assert.deepEqual(trafficDevices([{device:'192.0.2.5',deviceName:'spoof'}]), [{id:'192.0.2.5',platform:'generic'}]);
  assert.equal(isAddressDevice('127.0.0.1'), true);
  assert.equal(isAddressDevice('fe80::1'), true);
  for (const id of [sim, avd, 'android-device:adb']) assert.equal(isAddressDevice(id), false);
});

test('devices keep their place when traffic arrives and new ones are appended', () => {
  const ids = result => result.devices.map(device => device.id);
  // Newest-first records: B sent the latest request, A was seen first.
  let records = [{device:'B',startedAt:3}, {device:'A',startedAt:2}, {device:'B',startedAt:1.5}, {device:'A',startedAt:1}];
  let state = stableDeviceOrder(trafficDevices(records), [], records);
  assert.deepEqual(ids(state), ['A', 'B']);
  records = [{device:'B',startedAt:5}, ...records];
  state = stableDeviceOrder(trafficDevices(records), state.order, records);
  assert.deepEqual(ids(state), ['A', 'B']);
  records = [{device:'C',startedAt:6}, {device:'A',startedAt:5.5}, ...records];
  state = stableDeviceOrder(trafficDevices(records), state.order, records);
  assert.deepEqual(ids(state), ['A', 'B', 'C']);
  // A device whose records were deleted keeps its slot for when it returns.
  records = records.filter(record => record.device !== 'A');
  state = stableDeviceOrder(trafficDevices(records), state.order, records);
  assert.deepEqual(ids(state), ['B', 'C']);
  records = [{device:'A',startedAt:9}, ...records];
  assert.deepEqual(ids(stableDeviceOrder(trafficDevices(records), state.order, records)), ['A', 'B', 'C']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationIcon, recordApplicationId, trafficApplications, unknownApplicationId } from './applications.mjs';

const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
test('applications group by process attribution, never by device or user agent', () => {
  const records = [
    { application: { id: 'bundle:safari', name: 'Safari', kind: 'application', icon }, device: '127.0.0.1' },
    { application: { id: 'bundle:safari', name: 'Safari', kind: 'application' } },
    { application: { id: 'pid:42', name: 'curl', kind: 'process' } },
    { clientIsLocal: true, application: null },
    { clientIsLocal: false, devicePlatform: 'mac', request: { headers: { 'user-agent': 'Safari' } } },
    { device: '127.0.0.1' },
  ];
  assert.deepEqual(trafficApplications(records), [
    { id: 'pid:42', name: 'curl', kind: 'process', icon: undefined, count: 1 },
    { id: 'bundle:safari', name: 'Safari', kind: 'application', icon, count: 2 },
    { id: unknownApplicationId, name: 'Unknown app', kind: 'application', icon: undefined, count: 1 },
  ]);
  assert.equal(recordApplicationId(records[4]), null);
  assert.equal(recordApplicationId(records[5]), null);
});
test('applications take icons from the state icon map', () => {
  const records = [{ application: { id: 'bundle:safari', name: 'Safari', kind: 'application' } }];
  assert.equal(trafficApplications(records, { 'bundle:safari': icon })[0].icon, icon);
  assert.equal(trafficApplications(records, { 'bundle:safari': 'https://example.test/icon.png' })[0].icon, undefined);
});
test('application logos accept bounded PNG data only', () => {
  assert.equal(applicationIcon(icon), icon);
  for (const value of [undefined, 'https://example.test/icon.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,ZmFrZQ==', `${icon}${'A'.repeat(350000)}`]) assert.equal(applicationIcon(value), undefined);
  const bytes = Buffer.from(icon.slice(22), 'base64');
  bytes.writeUInt32BE(513, 16);
  assert.equal(applicationIcon(`data:image/png;base64,${bytes.toString('base64')}`), undefined);
});

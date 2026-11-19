import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceEvidence, androidRecordIds, simulatorRuntimeLabel, formatBytes, formatAgo } from './device-setup-evidence.mjs';
const now = 1800000000000;
const request = { id: 'request', startedAt: now / 1000, device: '127.0.0.1', deviceId: 'ios-simulator:example', url: 'https://api.example.com/', kind: 'request', sslInspected: true, statusCode: 200 };
test('matches exact attribution and engine epoch seconds, excluding older captures', () => {
  const match = { ids: ['ios-simulator:example'], since: now - 1 };
  assert.equal(deviceEvidence([request], match).https, 'ok');
  assert.equal(deviceEvidence([{ ...request, startedAt: now / 1000 - 5 }], match).traffic, false);
  assert.equal(deviceEvidence([{ ...request, deviceId: 'ios-simulator:other' }], match).traffic, false);
  assert.equal(deviceEvidence([{ ...request, deviceId: undefined }], match).traffic, false);
});
test('encrypted tunnels cannot prove certificate trust', () => {
  const evidence = deviceEvidence([{ ...request, kind: 'tunnel', isEncrypted: true }], { ids: [request.deviceId] });
  assert.equal(evidence.https, 'pending');
  assert.equal(evidence.tlsVerified, false);
});
test('TLS failures are shown and a later decrypted request can recover the check', () => {
  const failure = { ...request, id: 'failure', tlsFailure: { side: 'client' }, startedAt: now / 1000 - 1 };
  assert.equal(deviceEvidence([failure], { ids: [request.deviceId] }).https, 'error');
  assert.equal(deviceEvidence([failure, request], { ids: [request.deviceId] }).https, 'ok');
  const mixed = deviceEvidence([request, { ...failure, startedAt: now / 1000 + 1 }], { ids: [request.deviceId] });
  assert.equal(mixed.tlsVerified, true);
  assert.equal(mixed.https, 'error');
});
test('Metro status is not evidence of a successful bundle load', () => {
  assert.equal(deviceEvidence([{ ...request, url: 'http://localhost:8081/status' }], { ids: [request.deviceId] }).metro, false);
  assert.equal(deviceEvidence([{ ...request, url: 'http://localhost:8081/index.bundle?platform=ios' }], { ids: [request.deviceId] }).metro, true);
});
test('emulator matching includes AVD name and never ambiguous relay ids', () => {
  const ids = androidRecordIds({ serial: 'emulator-5554', name: 'Example_AVD', kind: 'emulator' });
  assert.ok(ids.includes('android-emulator:Example_AVD'));
  assert.ok(!ids.includes('android-device:adb'));
  assert.ok(!ids.includes('android-emulator:unknown'));
});
test('LAN evidence is isolated to the selected approved phone', () => {
  const one = { ...request, device: '192.168.1.30', deviceId: undefined, clientIsLocal: false };
  const two = { ...one, device: '192.168.1.31', tlsFailure: { side: 'client' } };
  assert.equal(deviceEvidence([one, two], { addresses: ['192.168.1.30'] }).https, 'ok');
});
test('reopening starts verification again without changing stored device identity', () => {
  const match = { ids: [request.deviceId], since: now + 1 };
  const reopened = deviceEvidence([request], match);
  assert.equal(reopened.traffic, false);
  assert.equal(reopened.tlsVerified, false);
  assert.equal(deviceEvidence([{ ...request, startedAt: now / 1000 + 2 }], match).tlsVerified, true);
});
test('renderer epoch milliseconds and ISO timestamps are supported too', () => {
  for (const startedAt of [now, new Date(now).toISOString()]) {
    assert.equal(deviceEvidence([{ ...request, startedAt }], { ids: [request.deviceId], since: now - 1 }).traffic, true);
  }
});
test('last bundle and first request details come from the matching device only', () => {
  const bundle = { ...request, id: 'bundle', url: 'http://localhost:8081/index.bundle?platform=ios', startedAt: now / 1000 + 2, responseSize: 14.2 * 1024 * 1024, durationMs: 3100, application: { name: 'Example App' } };
  const other = { ...bundle, id: 'other', deviceId: 'ios-simulator:other', responseSize: 1 };
  const evidence = deviceEvidence([request, bundle, other], { ids: [request.deviceId] });
  assert.deepEqual(evidence.bundle, { name: 'index.bundle', status: 200, size: 14.2 * 1024 * 1024, durationMs: 3100 });
  assert.deepEqual(evidence.first, { at: now, app: null });
  assert.equal(deviceEvidence([request], { ids: [request.deviceId] }).bundle, null);
});
test('simulator runtime identifiers become readable', () => {
  assert.equal(simulatorRuntimeLabel({ name: 'iPhone 16 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2' }), 'iOS 18.2');
  assert.equal(simulatorRuntimeLabel({ name: 'iPad Air', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2' }), 'iPadOS 18.2');
  assert.equal(simulatorRuntimeLabel({ name: 'x', runtime: 'unknown' }), 'unknown');
});
test('byte and age formatting', () => {
  assert.equal(formatBytes(14.2 * 1024 * 1024), '14.2 MB');
  assert.equal(formatBytes(null), '');
  assert.equal(formatAgo(1000, 3000), '2 s ago');
  assert.equal(formatAgo(0, 120000), '2 min ago');
});
test('shared emulator captures map to the only proxied emulator', async () => {
  const { androidRecordIds } = await import('./device-setup-evidence.mjs');
  const device = { kind: 'emulator', serial: 'emulator-5554', name: 'Example' };
  assert.equal(androidRecordIds(device).includes('android-emulator:unknown'), false);
  assert.equal(androidRecordIds(device, { soleProxiedEmulator: true }).includes('android-emulator:unknown'), true);
  assert.equal(androidRecordIds({ ...device, kind: 'physical' }, { soleProxiedEmulator: true }).includes('android-emulator:unknown'), false);
});

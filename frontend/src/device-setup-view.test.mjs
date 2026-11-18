import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice, deviceHeading } from './device-setup-view.mjs';
const connection = (cert, extra = {}) => ({ proxy: { status: 'ok' }, cert: { status: 'ok', ...cert }, metro: { status: 'off' }, connectedAt: 1, ...extra });
const emulator = (over = {}) => ({ serial: 'emulator-5554', kind: 'emulator', transport: 'emulator', state: 'device', name: 'Pixel_8', apiLevel: 35, release: '15', image: 'google_apis', rootable: true, connection: null, ...over });
const evidence = (over = {}) => ({ https: 'pending', metro: false, traffic: false, ...over });

test('headings match the mockup wording', () => {
  assert.deepEqual(deviceHeading(emulator()), { name: 'Pixel_8 · API 35', sub: 'emulator-5554', chips: [{ label: 'Google APIs', tone: 'ok' }, { label: 'root', tone: 'ok' }], icon: 'emulator' });
  const phone = deviceHeading(emulator({ kind: 'physical', transport: 'wifi', address: '192.168.1.42', serial: 'adb-1._adb-tls-connect._tcp', release: '16' }));
  assert.equal(phone.name, 'Pixel_8 · Android 16'); assert.equal(phone.sub, '192.168.1.42 · paired'); assert.equal(phone.chips[0].tone, 'acc');
  assert.equal(deviceHeading(emulator({ kind: 'physical', transport: 'usb', serial: 'R5CT1234ABC' })).sub, 'R5CT1234ABC · USB');
  assert.equal(deviceHeading({ udid: 'u', name: 'iPad Air', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', state: 'Booted', connection: null }).name, 'iPad Air · iPadOS 18.2');
});
test('unconnected and connecting cards', () => {
  assert.equal(describeDevice(emulator(), { evidence: evidence() }).state, 'idle');
  const connecting = describeDevice(emulator(), { evidence: evidence(), connecting: true, metro: true });
  assert.equal(connecting.state, 'connecting'); assert.equal(connecting.cert, 'running');
  assert.deepEqual(connecting.pills.map(([, tone]) => tone), ['spin', 'spin', 'idle', 'idle']);
});
test('system and simulator certificates are installed OS-wide; a pending user CA is a partial state', () => {
  const installed = describeDevice(emulator({ connection: connection({ mode: 'system' }) }), { evidence: evidence() });
  assert.equal(installed.state, 'connected');
  assert.equal(installed.tones.cert, 'idle');
  const tap = describeDevice(emulator({ connection: connection({ mode: 'user', status: 'pending' }) }), { evidence: evidence() });
  assert.equal(tap.state, 'partial'); assert.equal(tap.tones.cert, 'warn');
});
test('a confirmed user CA is only trusted after a decrypted request', () => {
  const device = emulator({ connection: connection({ mode: 'user' }) });
  assert.equal(describeDevice(device, { evidence: evidence() }).cert, 'installed');
  assert.equal(describeDevice(device, { evidence: evidence({ https: 'ok' }) }).cert, 'trusted');
});
test('decrypted traffic verifies a user CA even before manual confirmation', () => {
  const device = emulator({ connection: connection({ mode: 'user', status: 'pending' }) });
  const state = describeDevice(device, { evidence: evidence({ tlsVerified: true, https: 'ok' }) });
  assert.equal(state.cert, 'trusted');
  assert.equal(state.tones.cert, 'ok');
});
test('TLS failure turns the card partial regardless of certificate mode', () => {
  const result = describeDevice(emulator({ connection: connection({ mode: 'system' }) }), { evidence: evidence({ https: 'error' }) });
  assert.equal(result.cert, 'rejected'); assert.equal(result.state, 'partial'); assert.equal(result.tones.cert, 'err');
});
test('Metro is hidden unless enabled and green only after a bundle request', () => {
  const device = emulator({ connection: connection({ mode: 'system' }, { metro: { status: 'ok' } }) });
  assert.equal(describeDevice(device, { evidence: evidence() }).metro, 'hidden');
  assert.deepEqual(describeDevice(device, { evidence: evidence(), metro: true }).pills.map(p => p[0]), ['Proxy', 'HTTPS', 'Metro', 'Traffic']);
  assert.equal(describeDevice(device, { evidence: evidence(), metro: true }).tones.metro, 'idle');
  assert.equal(describeDevice(device, { evidence: evidence({ metro: true }), metro: true }).tones.metro, 'ok');
});
test('reverted cards do not keep earlier traffic or bundle evidence', () => {
  const old = evidence({ traffic: true, metro: true });
  const reverted = describeDevice(emulator(), { evidence: old, metro: true });
  assert.equal(reverted.tones.traffic, 'idle'); assert.equal(reverted.tones.metro, 'idle');
  assert.equal(describeDevice(emulator({ connection: connection({ mode: 'system' }) }), { evidence: old, metro: true }).tones.traffic, 'ok');
});

// Pure view-model for the Connect a device cards: turns inventory state plus capture evidence into
// the tones the UI shows. Tones: ok | warn | err | spin | idle. Certificate installation alone never
// proves that an app trusts the certificate.
import { simulatorRuntimeLabel } from './device-setup-evidence.mjs';

const tone = status => status === 'ok' ? 'ok' : status === 'running' ? 'spin' : status === 'error' ? 'err' : 'idle';

export function deviceHeading(device) {
  if ('serial' in device) {
    const physical = device.kind === 'physical';
    const version = physical ? (device.release ? `Android ${device.release}` : '') : (device.apiLevel ? `API ${device.apiLevel}` : '');
    const sub = device.transport === 'wifi' ? `${device.address ?? device.serial} · paired` : device.transport === 'usb' ? `${device.serial} · USB` : device.serial;
    const chips = [];
    if (device.kind === 'emulator') {
      chips.push(device.image === 'google_apis' ? { label: 'Google APIs', tone: 'ok' } : device.image === 'google_play' ? { label: 'Google Play' } : { label: 'Emulator' });
      if (device.rootable) chips.push({ label: 'root', tone: 'ok' });
    } else chips.push(device.transport === 'wifi' ? { label: 'Wireless debugging', tone: 'acc' } : { label: 'USB' });
    return { name: [device.name, version].filter(Boolean).join(' · '), sub: device.state === 'device' ? sub : `${sub} · ${device.state}`, chips, icon: device.kind === 'emulator' ? 'emulator' : 'phone' };
  }
  const runtime = simulatorRuntimeLabel(device);
  return { name: [device.name, runtime].filter(Boolean).join(' · '), sub: device.state, chips: [{ label: 'Simulator' }], icon: 'phone' };
}

export function describeDevice(device, { evidence, metro = false, connecting = false } = {}) {
  const connection = device.connection;
  const mode = connection?.cert.mode;
  const auto = mode === 'system' || mode === 'simulator';
  const active = connecting || ['proxy', 'cert', 'metro'].some(key => connection?.[key].status === 'running');
  let cert;
  if (active && connection?.cert.status !== 'ok' && connection?.cert.status !== 'error' || connecting && !connection) cert = 'running';
  else if (!connection) cert = 'none';
  else if (evidence?.tlsVerified || evidence?.https === 'ok') cert = 'trusted';
  else if (evidence?.https === 'error') cert = 'rejected';
  else if (connection.cert.status === 'error') cert = 'failed';
  else if (auto && connection.cert.status === 'ok') cert = 'auto';
  else if (mode === 'user' && connection.cert.status === 'pending') cert = 'tap';
  else if (mode === 'user' && connection.cert.status === 'ok') cert = 'installed';
  else cert = 'waiting';
  const certTone = { running: 'spin', none: 'idle', rejected: 'err', failed: 'err', auto: 'idle', tap: 'warn', trusted: 'ok', installed: 'idle', waiting: 'idle' }[cert];
  let metroKind = 'hidden';
  const live = !!connection || connecting; // evidence from an earlier session must not light up a disconnected card
  if (metro) metroKind = live && evidence?.metro ? 'bundle' : !connection ? 'none' : connection.metro.status === 'running' ? 'running' : connection.metro.status === 'error' ? 'failed' : connection.metro.status === 'ok' || connection.metro.status === 'skipped' ? 'ready' : 'waiting';
  const metroTone = { bundle: 'ok', running: 'spin', failed: 'err' }[metroKind] ?? 'idle';
  const proxyTone = connecting && !connection ? 'spin' : tone(connection?.proxy.status);
  const traffic = live && !!evidence?.traffic;
  const state = !connection && !connecting ? 'idle' : active ? 'connecting' : cert === 'tap' || certTone === 'err' || proxyTone === 'err' ? 'partial' : 'connected';
  return {
    state, cert, metro: metroKind, connected: !!connection && !active, canRetry: proxyTone === 'err' || cert === 'failed',
    tones: { proxy: proxyTone, cert: certTone, metro: metroTone, traffic: traffic ? 'ok' : 'idle' },
    pills: [['Proxy', proxyTone], ['HTTPS', certTone], ...(metro ? [['Metro', metroTone]] : []), ['Traffic', traffic ? 'ok' : 'idle']],
  };
}

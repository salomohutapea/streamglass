import { X509Certificate, createHash } from 'node:crypto';

export const validSerial = value => typeof value === 'string' && /^[a-zA-Z0-9_.:\[\]-]{1,200}$/.test(value);
export function parseAdbDevices(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/);
    if (!match || !validSerial(match[1])) return [];
    const [, serial, state, fields = ''] = match;
    return [{ serial, state, model: fields.match(/(?:^|\s)model:(\S+)/)?.[1]?.replaceAll('_', ' ') }];
  });
}
export function parseGetprop(text) {
  return Object.fromEntries([...text.matchAll(/^\[([^\]]+)\]: \[([^\r\n]*)\]\r?$/gm)].map(m => [m[1], m[2]]));
}
// Host part of an adb endpoint serial such as 192.168.1.42:37115 or [fe80::1]:37115; null for other serials.
export function endpointHost(serial) {
  const match = /^\[([0-9a-fA-F:.%]+)\]:\d+$/.exec(serial) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(serial);
  return match ? match[1] : null;
}
export function classifyAndroid(device, props = {}, avdName) {
  const emulator = /^emulator-/.test(device.serial) || props['ro.kernel.qemu'] === '1' || props['ro.boot.qemu'] === '1';
  const tags = [props['ro.product.name'], props['ro.system.product.name'], props['ro.build.tags'], props['ro.build.flavor']].join(' ').toLowerCase();
  const transport = emulator ? 'emulator' : /:\d+$|\._adb-tls-connect\._tcp\.?$/.test(device.serial) ? 'wifi' : 'usb';
  return { serial: device.serial, state: device.state, kind: emulator ? 'emulator' : 'physical', transport,
    address: transport === 'wifi' ? endpointHost(device.serial) : null,
    name: avdName || props['ro.product.model'] || device.model || device.serial,
    apiLevel: /^\d+$/.test(props['ro.build.version.sdk'] || '') ? Number(props['ro.build.version.sdk']) : null,
    release: props['ro.build.version.release'] || null,
    image: !emulator ? 'unknown' : /google.*play|gphone.*user$/.test(tags) ? 'google_play' : /google_apis|sdk_gphone/.test(tags) ? 'google_apis' : /aosp|sdk_phone|sdk_x86|sdk_arm/.test(tags) ? 'aosp' : 'unknown',
    rootable: emulator && props['ro.debuggable'] === '1' && ['eng', 'userdebug'].includes(props['ro.build.type']) && !/google.*play/.test(tags), connection: null };
}
export const metroStatus = body => body.trim() === 'packager-status:running';
export async function probeMetro(fetcher = fetch) {
  try { const response = await fetcher('http://127.0.0.1:8081/status', { signal: AbortSignal.timeout(650) }); return response.ok && metroStatus(await response.text()); } catch { return false; }
}
// X.509 TBSCertificate: optional version, serial, signature, issuer, validity, subject.
function tlv(buffer, start) {
  let offset = start + 1, length = buffer[offset++];
  if (length & 128) { const bytes = length & 127; if (!bytes || bytes > 4) throw new Error('Invalid DER length'); length = 0; for (let i = 0; i < bytes; i++) length = length * 256 + buffer[offset++]; }
  if (!Number.isSafeInteger(length) || offset + length > buffer.length) throw new Error('Invalid DER');
  return { start, content: offset, end: offset + length };
}
export function subjectHashOld(pem) {
  if (String(pem).includes('PRIVATE KEY')) throw new Error('Public certificate required');
  const der = new X509Certificate(pem).raw;
  const certificate = tlv(der, 0), tbs = tlv(der, certificate.content);
  let offset = tbs.content;
  if (der[offset] === 0xa0) offset = tlv(der, offset).end;
  for (let i = 0; i < 4; i++) offset = tlv(der, offset).end;
  const subject = tlv(der, offset);
  return createHash('md5').update(der.subarray(subject.start, subject.end)).digest().readUInt32LE(0).toString(16).padStart(8, '0');
}

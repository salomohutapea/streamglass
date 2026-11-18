import { randomBytes } from 'node:crypto';
export function parseMdns(text, type, name) {
  return text.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !fields[1].includes(type) || (name && fields[0] !== name && fields[0] !== `${name}.${type}.`)) return [];
    return /^[a-zA-Z0-9.\[\]:-]+:\d+$/.test(fields[2]) ? [{ name: fields[0], address: fields[2] }] : [];
  });
}
export function createAdbPairing({ adbPath, run, changed }) {
  let session, timer, busy = false;
  function cancel() { session = null; clearInterval(timer); timer = null; }
  async function tick() {
    const current = session;
    if (!current || busy) return;
    busy = true;
    try {
      if (Date.now() - current.started > 120000) { cancel(); changed({ status: 'error', message: 'Pairing timed out' }); return; }
      const adb = await adbPath();
      if (!adb || current !== session) return;
      const services = await run(adb, ['mdns', 'services']);
      if (current !== session) return;
      if (!current.paired) {
        const pairing = parseMdns(services, '_adb-tls-pairing._tcp', current.name)[0];
        if (!pairing) return;
        const result = await run(adb, ['pair', pairing.address, current.password]);
        if (!/Successfully paired/i.test(result)) throw new Error('adb did not confirm pairing');
        current.paired = true; current.host = pairing.address.replace(/:\d+$/, '');
        if (current !== session) return;
        changed({ status: 'paired', name: current.name });
      }
      // Only connect the host just paired, never an unrelated mDNS device.
      const connect = parseMdns(services, '_adb-tls-connect._tcp').find(item => item.address.replace(/:\d+$/, '') === current.host);
      if (connect && current === session) {
        const result = await run(adb, ['connect', connect.address]);
        if (!/connected to/i.test(result)) throw new Error('adb did not confirm connection');
        if (current !== session) return;
        cancel(); changed({ status: 'connected', name: current.name });
      }
    } catch { if (session === current) { cancel(); changed({ status: 'error', message: 'Wireless pairing failed. Check the phone and try again.' }); } }
    finally { busy = false; }
  }
  return { cancel, async start() {
    cancel(); if (!await adbPath()) throw new Error('adb unavailable');
    const name = `streamglass-${randomBytes(6).toString('hex')}`, password = randomBytes(12).toString('hex');
    session = { name, password, started: Date.now() };
    timer = setInterval(() => void tick(), 1500); timer.unref?.();
    changed({ status: 'waiting', name });
    return { name, qrText: `WIFI:T:ADB;S:${name};P:${password};;` };
  } };
}

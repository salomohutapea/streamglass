import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseAdbDevices, parseGetprop, classifyAndroid, probeMetro, subjectHashOld, validSerial, endpointHost } from './device-inventory.mjs';
import { parseMdns } from './adb-pairing.mjs';
import { createAdbPairing } from './adb-pairing.mjs';

const proxyKeys = ['http_proxy', 'global_http_proxy_host', 'global_http_proxy_port', 'global_http_proxy_exclusion_list'];
const defaults = { reapply: true, revertOnQuit: true, autoConnect: false, metroMode: 'auto' };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function systemCaScript(hash, apiLevel, revert = false) {
  if (!/^[0-9a-f]{8}$/.test(hash)) throw new Error('Invalid certificate hash');
  const dir = `/data/local/tmp/streamglass-ca-${hash}`;
  const namespaces = `FAILED=0; for PID in 1 $(pidof zygote zygote64 || true); do nsenter --mount=/proc/$PID/ns/mnt -- sh -c ${quote(revert ? `if grep -q ${quote(`streamglass-ca-${hash} /apex/com.android.conscrypt/cacerts `)} /proc/self/mountinfo; then umount /apex/com.android.conscrypt/cacerts; fi` : `if ! grep -q ${quote(`streamglass-ca-${hash} /apex/com.android.conscrypt/cacerts `)} /proc/self/mountinfo; then mount --bind ${dir} /apex/com.android.conscrypt/cacerts; fi`)} || FAILED=1; done; [ $FAILED = 0 ]`;
  if (revert) return `set -e\n${apiLevel >= 34 ? namespaces + '\n' : ''}if grep -q 'streamglass-ca-${hash} /system/etc/security/cacerts ' /proc/mounts; then umount /system/etc/security/cacerts; fi`;
  // Idempotent: a second run on the same boot (already mounted) must not copy the bind-mounted store onto itself.
  return `set -eu
if ! grep -q 'streamglass-ca-${hash} /system/etc/security/cacerts ' /proc/mounts; then
mkdir -p ${dir}
cp -a /system/etc/security/cacerts/. ${dir}/
${apiLevel >= 34 ? `cp -a /apex/com.android.conscrypt/cacerts/. ${dir}/` : ''}
cp /data/local/tmp/streamglass-${hash}.0 ${dir}/${hash}.0
chown -R 0:0 ${dir}
chmod 755 ${dir}
chmod 644 ${dir}/*
chcon -R u:object_r:system_file:s0 ${dir}
mount -t tmpfs -o mode=0755 streamglass-ca-${hash} /system/etc/security/cacerts
cp -a ${dir}/. /system/etc/security/cacerts/
chown 0:0 /system/etc/security/cacerts
chmod 755 /system/etc/security/cacerts
chcon u:object_r:system_file:s0 /system/etc/security/cacerts
fi
${apiLevel >= 34 ? namespaces : ''}`;
}

// All mutations use the parent's queue and snapshot file, including legacy/MCP actions.
export function createDeviceSetup({ dataDir, certificatePath, proxyPort, adbPath, run: baseRun, optional, readState, saveState, enqueue,
  performAction, ensureProxyListening, getLanInfo = async () => ({ enabled: false, address: null, setupUrl: null }),
  macMonitorEnabled = async () => false, emit = () => {}, metroProbe = probeMetro, now = Date.now }) {
  const optionsPath = path.join(dataDir, 'device-setup-options.json');
  const connections = new Map(), cache = new Map();
  let deadline = Infinity, hasDesired = false;
  const run = (file, args, timeout = 15000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Device restoration timed out; saved configuration retained');
    return baseRun(file, args, Math.min(timeout, remaining));
  };
  const retries = new Map(), inflight = new Set();
  let options, watching = false, timer, stopped = false, ticking = false, previous = new Set(), pairingState;
  async function getOptions() {
    if (!options) { try { options = { ...defaults, ...JSON.parse(await readFile(optionsPath, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; options = { ...defaults }; } }
    return options;
  }
  const keyOf = (platform, id) => `${platform}:${id}`;
  async function inventory() {
    const opts = await getOptions(), adb = await adbPath(), savedState = await readState();
    const [androidText, iosText, running, lan] = await Promise.all([
      adb ? optional(adb, ['devices', '-l']) : null,
      optional('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j']), metroProbe(), getLanInfo(),
    ]);
    const rows = parseAdbDevices(androidText || '');
    const active = new Set(rows.filter(d => d.state === 'device').map(d => d.serial));
    for (const serial of cache.keys()) if (!active.has(serial)) cache.delete(serial);
    const android = await Promise.all(rows.map(async row => {
      let info = cache.get(row.serial);
      if (row.state === 'device' && (!info || now() - info.time > 60000)) {
        const props = parseGetprop(await optional(adb, ['-s', row.serial, 'shell', 'getprop']) || '');
        const device = classifyAndroid(row, props);
        const avd = device.kind === 'emulator' ? await optional(adb, ['-s', row.serial, 'emu', 'avd', 'name']) : null;
        info = { time: now(), device: classifyAndroid(row, props, avd?.split(/\r?\n/).find(s => s && s !== 'OK')) };
        cache.set(row.serial, info);
      }
      return { ...(info?.device || classifyAndroid(row)), state: row.state, connection: connections.get(keyOf('android', row.serial)) || savedState[keyOf('android', row.serial)]?.setup?.connection || null };
    }));
    // mDNS wireless-debugging serials carry no IP; resolve them so the UI can match the phone's LAN traffic.
    const unresolved = android.filter(d => d.transport === 'wifi' && !d.address);
    if (unresolved.length && adb) {
      const services = await optional(adb, ['mdns', 'services']) || '';
      for (const device of unresolved) {
        const name = device.serial.replace(/\._adb-tls-connect\._tcp\.?$/, '');
        const found = parseMdns(services, '_adb-tls-connect._tcp', name)[0];
        device.address = found ? endpointHost(found.address) : null;
      }
    }
    let iosSimulators = [], simctlAvailable = iosText !== null;
    try { iosSimulators = Object.entries(JSON.parse(iosText || '{}').devices || {}).flatMap(([runtime, devices]) => devices.filter(d => d.state === 'Booted').map(d => ({ udid: d.udid, name: d.name, state: d.state, runtime, connection: connections.get(keyOf('ios-simulator', d.udid)) || null }))); } catch { simctlAvailable = false; }
    return { adbAvailable: Boolean(adb), simctlAvailable, android, iosSimulators,
      metro: { running, port: 8081, mode: opts.metroMode }, lan: { ...lan, proxyPort },
      options: { reapply: opts.reapply, revertOnQuit: opts.revertOnQuit, autoConnect: opts.autoConnect }, ...(pairingState ? { pairing: pairingState } : {}) };
  }
  async function publish() { const inv = await inventory(); emit(inv); return inv; }
  const pairing = createAdbPairing({ adbPath, run, changed: state => { pairingState = state; void publish().catch(() => {}); } });
  function validate(req) {
    if (!req || !['android', 'ios-simulator'].includes(req.platform) || !validSerial(req.id)) throw new Error('Invalid device');
    if (req.metro !== undefined && typeof req.metro !== 'boolean') throw new Error('Invalid Metro option');
  }
  async function publicCert() {
    const pem = await readFile(certificatePath, 'utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY')) throw new Error('Public PEM certificate required');
    return pem;
  }
  // Android's CA picker only lists .crt (application/x-x509-ca-cert); a hash-named file never replaces a user's own download.
  const installerName = pem => `streamglass-ca-${subjectHashOld(pem)}.crt`;
  // `adb root` / `unroot` restart adbd, which drops every reverse, including other tools'. Put foreign ones back.
  async function keepingReverses(adb, id, change, owned = []) {
    const listing = await optional(adb, ['-s', id, 'reverse', '--list']) || '';
    const before = listing.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length >= 3 && /^tcp:\d+$/.test(p.at(-2)) && /^[a-z]+:[\w./-]+$/.test(p.at(-1)) && !owned.includes(Number(p.at(-2).slice(4))));
    const result = await change();
    await optional(adb, ['-s', id, 'wait-for-device'], 10000);
    for (const p of before) await optional(adb, ['-s', id, 'reverse', '--no-rebind', p.at(-2), p.at(-1)]);
    return result;
  }
  async function installer(adb, id) {
    const name = installerName(await publicCert()), target = `/sdcard/Download/${name}`;
    await run(adb, ['-s', id, 'push', certificatePath, target]);
    // Index the file so the picker's Recent and Downloads views show it; best effort across Android versions.
    await optional(adb, ['-s', id, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${target}`]);
    await run(adb, ['-s', id, 'shell', 'am', 'start', '-a', 'android.settings.SECURITY_SETTINGS']);
    return name;
  }
  async function connect(req, inv = null) {
    validate(req); inv ||= await inventory();
    const connection = { proxy: { status: 'running' }, cert: { status: 'pending' }, metro: { status: 'off' }, connectedAt: now() };
    const key = keyOf(req.platform, req.id);
    try {
      if (req.platform === 'ios-simulator') {
        if (!inv.iosSimulators.some(d => d.udid === req.id)) throw new Error('Select a booted simulator');
        const owned = !await macMonitorEnabled();
        await publicCert(); await ensureProxyListening();
        await run('/usr/bin/xcrun', ['simctl', 'keychain', req.id, 'add-root-cert', certificatePath]);
        connection.cert = { status: 'ok', mode: 'simulator' };
        // Simulators share this Mac's network: localhost:8081 already is Metro, no tunnel needed.
        const metro = req.metro ?? (inv.metro.mode === 'always' || inv.metro.mode === 'auto' && inv.metro.running);
        connection.metro = metro ? { status: 'ok', detail: 'localhost:8081 is this Mac; nothing to change.' } : { status: 'off' };
        // Existing Mac monitor records exact prior state and owns quit restoration.
        await performAction({ action: 'mac-enable-proxy' });
        connection.proxy = { status: 'ok', value: `127.0.0.1:${proxyPort}` };
        connections.set(key, connection);
        const state = await readState(); state[key] = { macOwned: state[key]?.macOwned ?? owned }; await saveState(state);
      } else {
        const device = inv.android.find(d => d.serial === req.id && d.state === 'device');
        if (!device) throw new Error('Select an authorized online Android device');
        if (device.transport === 'wifi' && (!inv.lan.enabled || !inv.lan.address)) throw new Error('Enable LAN access and connect this Mac to a network before connecting a wireless Android device');
        const host = device.kind === 'emulator' ? '10.0.2.2' : device.transport === 'usb' ? '127.0.0.1' : inv.lan.address;
        if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('Invalid proxy host');
        await publicCert(); await ensureProxyListening();
        const adb = await adbPath();
        const shell = args => run(adb, ['-s', req.id, 'shell', ...args]);
        const state = await readState();
        if (!state[key]) {
          state[key] = Object.fromEntries(await Promise.all(proxyKeys.map(async name => [name, await shell(['settings', 'get', 'global', name])])));
        }
        const saved = state[key];
        saved.setup ||= { reverses: [], proxyValue: `${host}:${proxyPort}`, apiLevel: device.apiLevel, desired: req, transport: device.transport };
        saved.setup.desired = req; saved.setup.proxyValue = `${host}:${proxyPort}`;
        await saveState(state); connections.set(key, connection);
        await shell(['settings', 'put', 'global', 'http_proxy', saved.setup.proxyValue]);
        connection.proxy = { status: 'ok', value: saved.setup.proxyValue };
        let rooted = false;
        if (device.rootable && device.kind === 'emulator') { // never alter a physical phone's system trust store
          const wasRoot = (await optional(adb, ['-s', req.id, 'shell', 'id', '-u']))?.trim() === '0';
          try { const result = wasRoot ? 'already root' : await keepingReverses(adb, req.id, () => run(adb, ['-s', req.id, 'root'])); rooted = !/cannot|not allowed|production builds|denied/i.test(result); } catch { rooted = false; }
          if (rooted) await run(adb, ['-s', req.id, 'wait-for-device'], 10000);
          if (rooted) { saved.setup.wasRoot ??= wasRoot; await saveState(state); } // first connect decides; reboot re-applies keep it
        }
        if (rooted) {
          if (!device.apiLevel) throw new Error('Cannot determine Android API level for system CA installation');
          const hash = subjectHashOld(await publicCert());
          saved.setup.systemCa = { hash, apiLevel: device.apiLevel, bootId: (await optional(adb, ['-s', req.id, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']))?.trim() || null };
          await saveState(state);
          await run(adb, ['-s', req.id, 'push', certificatePath, `/data/local/tmp/streamglass-${hash}.0`]);
          await shell(['sh', '-c', quote(systemCaScript(hash, device.apiLevel))]);
          connection.cert = { status: 'ok', mode: 'system', detail: 'System CA installed until reboot (re-applied automatically). Apps using Android’s trust store accept it after they restart; browsers with their own root store, such as recent Chrome, may still reject it.' };
        } else {
          connection.cert = { status: 'pending', mode: 'user', file: await installer(adb, req.id) };
        }
        // Reverses come after `adb root`, which restarts adbd and drops existing reverses.
        const metro = req.metro ?? (inv.metro.mode === 'always' || inv.metro.mode === 'auto' && inv.metro.running);
        const ports = [...new Set([...(device.transport === 'usb' ? [proxyPort] : []), ...(metro && device.transport !== 'wifi' ? [8081] : [])])];
        for (const port of ports) {
          const listing = await run(adb, ['-s', req.id, 'reverse', '--list']);
          const existing = listing.split('\n').map(l => l.trim().split(/\s+/)).find(parts => parts.at(-2) === `tcp:${port}`);
          if (existing && existing.at(-1) !== `tcp:${port}`) throw new Error(`Port ${port} is already reversed by another tool`);
          if (!existing) {
            if (!saved.setup.reverses.includes(port)) saved.setup.reverses.push(port);
            await saveState(state); // Journal before mutation, so partial failures can be reverted.
            await run(adb, ['-s', req.id, 'reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`]);
          }
        }
        connection.metro = { status: metro ? device.transport === 'wifi' ? 'skipped' : 'ok' : 'off', ...(metro && device.transport === 'wifi' ? { detail: 'Use the Mac LAN address for Metro on Wi-Fi' } : {}) };
        saved.setup.connection = connection; await saveState(state);
      }
      previous.add(key); hasDesired = true; schedule();
      return { ok: true, connection, message: connection.cert.status === 'pending' ? 'Proxy connected. Install the CA certificate from Downloads, then confirm.' : 'Device connected', inventory: await publish() };
    } catch (error) {
      if (connections.has(key)) { hasDesired = true; previous.add(key); schedule(); }
      if (connection.proxy.status === 'running') connection.proxy.status = 'error';
      else connection.cert = { ...connection.cert, status: 'error', detail: error.message };
      return { ok: false, connection, message: error.message, inventory: await publish() };
    }
  }
  async function disconnect(req, quiet = false) {
    validate(req);
    const key = keyOf(req.platform, req.id), state = await readState(), saved = state[key];
    if (saved && req.platform === 'android') {
      const adb = await adbPath(); if (!adb) throw new Error('adb unavailable; saved configuration retained');
      const shell = args => run(adb, ['-s', req.id, 'shell', ...args]);
      const current = await shell(['settings', 'get', 'global', 'http_proxy']);
      // Do not overwrite proxy settings changed since our connect.
      if (!saved.setup || current === saved.setup.proxyValue) {
        for (const name of proxyKeys) {
          const value = saved[name];
          if (typeof value !== 'string') continue;
          await shell(value === 'null' ? ['settings', 'delete', 'global', name] : ['settings', 'put', 'global', name, quote(value)]);
        }
      }
      for (const port of saved.setup?.reverses || []) {
        const listing = await run(adb, ['-s', req.id, 'reverse', '--list']);
        if (listing.split('\n').some(line => { const p = line.trim().split(/\s+/); return p.at(-2) === `tcp:${port}` && p.at(-1) === `tcp:${port}`; })) await run(adb, ['-s', req.id, 'reverse', '--remove', `tcp:${port}`]);
      }
      const file = saved.setup?.connection?.cert?.file;
      if (typeof file === 'string' && /^streamglass-ca-[0-9a-f]{8}\.crt$/.test(file)) await optional(adb, ['-s', req.id, 'shell', 'rm', '-f', `/sdcard/Download/${file}`]);
      if (saved.setup?.systemCa) {
        const { hash, apiLevel, bootId } = saved.setup.systemCa;
        const nowBoot = (await optional(adb, ['-s', req.id, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']))?.trim();
        // A reboot already cleared the tmpfs/bind mounts; only the root-owned staging files remain.
        const rebooted = !!bootId && !!nowBoot && bootId !== nowBoot;
        // Mounts and staging files are root-owned; a reboot or another tool may have unrooted adbd.
        if ((await optional(adb, ['-s', req.id, 'shell', 'id', '-u']))?.trim() !== '0') {
          await keepingReverses(adb, req.id, () => optional(adb, ['-s', req.id, 'root']));
        }
        if (!rebooted) {
          try { await shell(['sh', '-c', quote(systemCaScript(hash, apiLevel, true))]); }
          catch { throw new Error('Proxy restored. System CA mounts could not be removed; reboot the emulator to clear temporary trust, then retry Revert.'); }
        }
        await optional(adb, ['-s', req.id, 'shell', 'rm', '-rf', `/data/local/tmp/streamglass-${hash}.0`, `/data/local/tmp/streamglass-ca-${hash}`]);
        // Leave adbd as we found it.
        if (saved.setup.wasRoot === false) await keepingReverses(adb, req.id, () => optional(adb, ['-s', req.id, 'unroot']), saved.setup.reverses || []);
      }
    } else if (saved?.macOwned) {
      const other = Object.keys(state).some(k => k.startsWith('ios-simulator:') && k !== key);
      if (!other) await performAction({ action: 'mac-restore-proxy' });
      else { const next = Object.keys(state).find(k => k.startsWith('ios-simulator:') && k !== key); state[next].macOwned = true; await saveState(state); }
      // performAction may have removed Mac entries; reload before saving.
    }
    const latest = await readState(); delete latest[key]; await saveState(latest);
    connections.delete(key);
    hasDesired = Object.values(latest).some(value => value?.setup?.desired); schedule();
    return { ok: true, message: req.platform === 'ios-simulator' ? 'Proxy restored. Simulator CA trust remains installed.' : 'Saved configuration restored', ...(quiet ? {} : { inventory: await publish() }) };
  }
  async function revertAll({ quit = false } = {}) {
    const state = await readState(), errors = [];
    for (const key of Object.keys(state)) {
      if (!key.startsWith('android:') && !key.startsWith('ios-simulator:')) continue;
      if (quit && (!key.startsWith('android:') || !state[key].setup)) continue;
      try { await disconnect({ platform: key.startsWith('android:') ? 'android' : 'ios-simulator', id: key.slice(key.indexOf(':') + 1) }, quit); } catch (error) { errors.push(error.message); }
    }
    return { ok: !errors.length, message: errors.join('\n') || 'Saved device settings restored', ...(quit ? {} : { inventory: await publish() }) };
  }
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const inv = await inventory(), opts = await getOptions(), state = await readState();
      const current = new Set([...inv.android.filter(d => d.state === 'device').map(d => `android:${d.serial}`), ...inv.iosSimulators.map(d => `ios-simulator:${d.udid}`)]);
      for (const key of current) {
        if (stopped) return;
        if (previous.has(key) || inflight.has(key)) continue;
        const saved = state[key], id = key.slice(key.indexOf(':') + 1), platform = key.startsWith('android:') ? 'android' : 'ios-simulator';
        const device = inv.android.find(d => d.serial === id);
        if (saved?.setup && opts.reapply && ['emulator', 'usb'].includes(device?.transport)) {
          // adb lists a rebooting device as online before settings, package manager and adbd root are usable.
          if ((await optional(await adbPath(), ['-s', id, 'shell', 'getprop', 'sys.boot_completed']))?.trim() !== '1') { current.delete(key); continue; }
          // Re-read when the queued task runs: a Revert or manual Connect queued ahead of it wins.
          inflight.add(key);
          const result = await enqueue(async () => { try { const latest = (await readState())[key]; return latest?.setup?.desired ? connect(latest.setup.desired) : { ok: true }; } finally { inflight.delete(key); } });
          const tries = (retries.get(key) ?? 0) + 1;
          if (result?.ok || tries >= 5) retries.delete(key); else { retries.set(key, tries); current.delete(key); } // retry on the next tick
        }
        else if (!saved && opts.autoConnect && (platform === 'ios-simulator' || device?.kind === 'emulator')) await enqueue(async () => (await readState())[key] ? { ok: true } : connect({ platform, id }));
      }
      previous = current;
      if (watching || pairingState) emit(await inventory());
    } finally { ticking = false; }
  }
  function schedule() {
    clearInterval(timer); timer = null;
    if (stopped || !options || !(watching || options.reapply && hasDesired || options.autoConnect)) return;
    timer = setInterval(() => void tick().catch(() => {}), watching ? 2000 : 10000); timer.unref?.();
  }
  return {
    inventory, reconcile: tick,
    async watch(on) { if (typeof on !== 'boolean') throw new Error('Expected boolean'); watching = on; await getOptions(); schedule(); if (on) await publish(); },
    // User actions mark the device in flight so a concurrent watcher tick doesn't queue a second connect behind them.
    connect: req => { const key = keyOf(req?.platform, req?.id); inflight.add(key); return enqueue(() => connect(req)).finally(() => { inflight.delete(key); previous.add(key); }); },
    disconnect: req => { const key = keyOf(req?.platform, req?.id); inflight.add(key); return enqueue(() => disconnect(req)).finally(() => { inflight.delete(key); previous.add(key); }); }, revertAll: () => enqueue(() => revertAll()),
    setOptions: patch => enqueue(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid device options');
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'metroMode' ? !['auto', 'always', 'off'].includes(value) : !['reapply', 'revertOnQuit', 'autoConnect'].includes(key) || typeof value !== 'boolean') throw new Error('Invalid device option');
      }
      options = { ...await getOptions(), ...patch };
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${optionsPath}.tmp`, JSON.stringify(options), { mode: 0o600 }); await rename(`${optionsPath}.tmp`, optionsPath);
      schedule(); return publish();
    }),
    confirm: req => enqueue(async () => {
      validate(req); if (req.platform !== 'android') throw new Error('Android required');
      const connection = connections.get(keyOf(req.platform, req.id)) || (await readState())[keyOf(req.platform, req.id)]?.setup?.connection;
      if (connection?.cert.mode === 'user') connection.cert = { status: 'ok', mode: 'user', detail: 'Installation confirmed by user; HTTPS trust has not been probed' };
      if (connection) { const state = await readState(); if (state[keyOf(req.platform, req.id)]?.setup) { state[keyOf(req.platform, req.id)].setup.connection = connection; await saveState(state); } }
      return publish();
    }),
    reopen: req => enqueue(async () => { validate(req); if (req.platform !== 'android' || !(await inventory()).android.some(d => d.serial === req.id && d.state === 'device')) throw new Error('Select an online Android device'); await installer(await adbPath(), req.id); }),
    startPairing: () => pairing.start(), cancelPairing: () => { pairing.cancel(); pairingState = { status: 'cancelled' }; void publish().catch(() => {}); },
    async start() { stopped = false; deadline = Infinity; await getOptions(); hasDesired = Object.values(await readState()).some(value => value?.setup?.desired); schedule(); },
    async prepareQuit() { stopped = true; clearInterval(timer); pairing.cancel(); deadline = Date.now() + 6000; if ((await getOptions()).revertOnQuit) return revertAll({ quit: true }); return { ok: true, message: '' }; },
    dispose() { stopped = true; clearInterval(timer); pairing.cancel(); },
  };
}

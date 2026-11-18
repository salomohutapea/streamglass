import { createDeviceSetup } from './device-setup.mjs';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// The Android SDK's adb, from ANDROID_HOME, ANDROID_SDK_ROOT, the default SDK folder or PATH. Shared with the
// application resolver so it never runs a binary named only by a socket owner's path.
export async function findAdb({ executeCommand = execute } = {}) {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(homedir(), 'Library/Android/sdk')];
  const candidates = roots.filter(root => root && path.isAbsolute(root)).map(root => path.join(root, 'platform-tools/adb'));
  let fromPath = null;
  try { fromPath = (await executeCommand('/usr/bin/which', ['adb'], { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim(); } catch { /* adb is not on PATH. */ }
  if (fromPath && path.isAbsolute(fromPath)) candidates.push(fromPath);
  for (const candidate of new Set(candidates)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed SDK. */ }
  }
  return null;
}

export function createDeviceService({ dataDir, certificatePath, proxyPort, ensureProxyListening = async () => {}, executeCommand = execute, platform = process.platform, getLanInfo, emitInventory, metroProbe }) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw new Error('Invalid proxy port');
  if (!path.isAbsolute(certificatePath)) throw new Error('Public certificate path must be absolute');
  const intentPath = path.join(dataDir, 'mac-monitor.json');
  const readIntent = async () => { try { return JSON.parse(await readFile(intentPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const saveIntent = async intent => { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await writeFile(`${intentPath}.tmp`, JSON.stringify(intent), { mode: 0o600 }); await rename(`${intentPath}.tmp`, intentPath); };
  const statePath = path.join(dataDir, 'device-proxy-state.json');
  const run = async (file, args, timeout = 15000) => (await executeCommand(file, args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
  const optional = async (file, args) => { try { return await run(file, args); } catch { return null; } };
  const readState = async () => { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
  const save = async state => { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 }); await rename(`${statePath}.tmp`, statePath); };
  const elevated = async commands => {
    const command = commands.map(([file, ...args]) => [file, ...args].map(quote).join(' ')).join(' && ');
    await run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], 120000);
  };
  let monitorError = '', timer, networkCache, observedNetwork, monitorTickPending = false, suspended = false;
  let adminMembership;
  const isAdministrator = () => adminMembership ??= optional('/usr/bin/id', ['-Gn']).then(groups => Boolean(groups?.split(/\s+/).includes('admin')));
  const permissionDenied = message => Object.assign(new Error(message), { code: 'PROXY_PERMISSION' });
  const permissionPattern = /permission|not authorized|admin|privilege|root|access denied|authorization/i;
  const configureNetwork = async (commands, allowAdmin = true) => {
    try { for (const [file, ...args] of commands) { const output = await run(file, args); if (permissionPattern.test(output)) throw new Error(output); } }
    catch (error) {
      const text = `${error.message} ${error.stderr ?? ''}`;
      // networksetup rejects unauthorised changes with varying wording (often just "Command failed"), so only an unknown service name is excluded.
      const networksetupFailure = /\/usr\/sbin\/networksetup/.test(text) && !/not a recognized network service|could not find network service/i.test(text);
      if (!permissionPattern.test(text) && !networksetupFailure) throw error;
      if (!allowAdmin) throw permissionDenied('Mac monitor could not update this network proxy without permission. Open Device Setup and enable Mac capture to retry, or ask IT to configure HTTP/HTTPS proxies. Monitoring remains enabled.');
      if (!await isAdministrator()) throw permissionDenied('This account cannot change system proxy settings. Ask IT to configure the HTTP/HTTPS proxy, or set the proxy inside your app. Certificate setup remains available without system proxy access.');
      try { await elevated(commands); } catch (cause) { throw permissionDenied(`macOS requires administrator approval for network proxy changes. Use an administrator account or configure HTTP/HTTPS proxies manually in Network settings. ${cause.message}`); }
    }
  };
  const verifyNetwork = async (target, expected) => {
    for (const [type, previous] of Object.entries(expected)) {
      const text = await run('/usr/sbin/networksetup', [`-get${type}proxy`, target]);
      const fields = Object.fromEntries(text.split('\n').map(line => { const i = line.indexOf(': '); return [line.slice(0, i), line.slice(i + 2)]; }));
      if (fields.Enabled !== (previous.enabled ? 'Yes' : 'No') || previous.host && (fields.Server !== previous.host || fields.Port !== previous.port)) throw new Error('Network proxy settings did not match the requested configuration. Saved original settings are retained; check macOS Network settings.');
    }
  };
  async function restoreMacProxies(state, { automatic = false, onlyOwned = automatic } = {}) {
    const failures = [];
    for (const key of Object.keys(state).filter(key => key.startsWith('mac:'))) {
      const target = key.slice(4);
      try {
        const expected = {};
        const { appliedPort = proxyPort, ...proxies } = state[key];
        for (const [type, previous] of Object.entries(proxies)) {
          if (onlyOwned) {
            const current = await run('/usr/sbin/networksetup', [`-get${type}proxy`, target]);
            if (!/^Enabled: Yes$/m.test(current) || !/^Server: 127\.0\.0\.1$/m.test(current) || !current.split('\n').includes(`Port: ${appliedPort}`)) continue;
          }
          // Restoring an old snapshot of this same listener would leave a dead proxy after exit.
          expected[type] = automatic && previous.enabled && previous.host === '127.0.0.1' && previous.port === String(proxyPort) ? {...previous, enabled:false} : previous;
        }
        await configureNetwork(Object.entries(expected).flatMap(([type, previous]) => [
          ...(previous.host ? [['/usr/sbin/networksetup', `-set${type}proxy`, target, previous.host, previous.port]] : []),
          ['/usr/sbin/networksetup', `-set${type}proxystate`, target, previous.enabled ? 'on' : 'off'],
        ]), !automatic);
        await verifyNetwork(target, expected);
        const restored = {...state}; delete restored[key];
        await save(restored); delete state[key];
      } catch (error) { failures.push(`${target}: ${error.message}`); }
    }
    return failures;
  }
  const trustMacCertificate = () => run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', path.join(homedir(), 'Library/Keychains/login.keychain-db'), certificatePath], 120000);
  async function macCertificateStatus() {
    if (platform !== 'darwin') return null;
    let fingerprint;
    try {
      fingerprint = new X509Certificate(await readFile(certificatePath)).fingerprint256.replaceAll(':', '');
    } catch {
      return null;
    }

    // Match the active CA exactly. Other Streamglass profiles may have the same certificate name.
    const keychainResults = await Promise.allSettled([
      run('/usr/bin/security', ['find-certificate', '-a', '-Z'], 3000),
      run('/usr/bin/security', ['find-certificate', '-a', '-Z', '/Library/Keychains/System.keychain'], 3000),
    ]);
    const hashLine = `SHA-256 hash: ${fingerprint}`;
    const installed = keychainResults.some(result => result.status === 'fulfilled' && result.value.split(/\r?\n/).includes(hashLine));
    if (!installed) {
      return keychainResults.every(result => result.status === 'fulfilled') ? { installed: false, trusted: null } : null;
    }

    try {
      // Let macOS use its configured trust settings. Supplying a root with -r would bypass that check.
      await run('/usr/bin/security', ['verify-cert', '-c', certificatePath, '-p', 'ssl', '-l', '-L'], 3000);
      return { installed: true, trusted: true };
    } catch (error) {
      const rejected = /^Cert Verify Result:|^SecTrustEvaluate result: kSecTrustResultDeny/m.test(error.stderr ?? '');
      return { installed: true, trusted: rejected ? false : null };
    }
  }
  const adbPath = () => findAdb({ executeCommand });
  async function networks(refresh = false) {
    if (!networkCache || refresh) {
      const [servicesText, orderText] = await Promise.all([
        optional('/usr/sbin/networksetup', ['-listallnetworkservices']),
        optional('/usr/sbin/networksetup', ['-listnetworkserviceorder']),
      ]);
      const interfaces = new Map();
      let serviceName;
      for (const line of (orderText ?? '').split('\n')) {
        const service = line.match(/^\(\d+\) (.+)$/);
        if (service) serviceName = service[1];
        const device = line.match(/Device: ([^)]+)\)/);
        if (device && serviceName) { interfaces.set(serviceName, device[1]); serviceName = undefined; }
      }
      networkCache = (servicesText ?? '').split('\n').slice(1).filter(name => name && !name.startsWith('*')).map(name => ({ id: name, name, interface: interfaces.get(name) ?? null }));
    }
    const [route4, route6] = await Promise.all([
      optional('/sbin/route', ['-n', 'get', 'default']),
      optional('/sbin/route', ['-n', 'get', '-inet6', 'default']),
    ]);
    const routes = [...new Set([route4, route6].map(text => text?.match(/^\s*interface:\s*(\S+)/m)?.[1]).filter(Boolean))];
    const candidates = networkCache.filter(service => routes.includes(service.interface));
    const activeNetworkId = candidates.length === 1 && routes.every(device => device === candidates[0].interface) ? candidates[0].id : null;
    const networkNotice = activeNetworkId ? `Active network: ${activeNetworkId} (${candidates[0].interface}). Mac monitoring follows network changes automatically.` : routes.length ? 'Multiple default networks or a VPN prevent automatic selection. Use the advanced network override.' : 'Waiting for an active network. Mac monitoring will resume when it connects.';
    observedNetwork = { networkServices: networkCache.map(service => ({ ...service, active: service.id === activeNetworkId })), activeNetworkId, networkNotice };
    return observedNetwork;
  }
  async function list() {
    const adb = await adbPath();
    const [simText, androidText, network, state, intent, macCertificate] = await Promise.all([
      optional('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '--json']),
      adb ? optional(adb, ['devices']) : null,
      platform === 'darwin' ? networks(true) : { networkServices: [], activeNetworkId: null, networkNotice: 'macOS required' },
      readState(), readIntent(), macCertificateStatus(),
    ]);
    const simulators = simText ? Object.values(JSON.parse(simText).devices).flat().map(({ udid, name, state }) => ({ id: udid, name, state })) : [];
    const android = androidText ? androidText.split('\n').slice(1).filter(line => /\tdevice$/.test(line)).map(line => ({ id: line.split('\t')[0], name: line.split('\t')[0] })) : [];
    const { networkServices, activeNetworkId, networkNotice } = network;
    await Promise.all(networkServices.map(async service => {
      service.active = service.id === activeNetworkId;
      const current = await Promise.all(['web', 'secureweb'].map(type => optional('/usr/sbin/networksetup', [`-get${type}proxy`, service.id])));
      service.proxyEnabled = current.every(text => text && /^Enabled: Yes$/m.test(text) && /^Server: 127\.0\.0\.1$/m.test(text) && new RegExp(`^Port: ${proxyPort}$`, 'm').test(text));
      service.canRestore = Boolean(state[`mac:${service.id}`]);
    }));
    const simulatorNotice = simText === null ? 'Simulator tools are unavailable or could not be queried. Check full Xcode, its selected developer directory, and Simulator availability, then refresh.' : simulators.some(item => item.state === 'Booted') ? 'Select a booted simulator and prepare capture to trust certificates and enable the Mac proxy.' : 'No booted simulator detected. Boot a simulator in Xcode or Simulator, then refresh.';
    return { simulatorNotice, simulators, android, networkServices, activeNetworkId, networkNotice, adbAvailable: Boolean(adb), simulatorToolsAvailable: simText !== null, savedProxyTargets: Object.keys(state), certificatePath, macCertificate, proxyPort, monitorTarget: intent?.enabled ? intent.override || activeNetworkId : null, monitorEnabled: Boolean(intent?.enabled), monitorOverride: intent?.override ?? null, monitorError };
  }
  let pending = Promise.resolve();
  async function performAction({ action, target, networkTarget, restoring = false, networkOnly = false, metro = false, onlyOwned = false } = {}) {
    if (['mac-trust-ca', 'simulator-install-ca', 'simulator-prepare', 'simulator-certificates', 'android-install-ca'].includes(action)) {
      const certificate = await readFile(certificatePath, 'utf8');
      if (!certificate.includes('-----BEGIN CERTIFICATE-----') || certificate.includes('PRIVATE KEY')) throw new Error('A public PEM certificate is required');
    }
    const devices = networkOnly ? await networks() : await list();
    const state = await readState();
    const requireTarget = items => { if (typeof target !== 'string' || !items.some(item => item.id === target)) throw new Error('Select an available device or network service'); };
    if (['simulator-prepare', 'simulator-certificates'].includes(action)) {
      if (platform !== 'darwin') throw new Error('macOS required');
      requireTarget(devices.simulators);
      if (devices.simulators.find(item => item.id === target).state !== 'Booted') throw new Error('Boot the selected simulator first');
      const network = networkTarget || devices.activeNetworkId;
      if (action === 'simulator-prepare' && !devices.networkServices.some(item => item.id === network)) throw new Error('Select an available Mac network service');
      let completed = 'No setup steps completed';
      try {
        if (action === 'simulator-prepare') { await ensureProxyListening(); completed = 'Proxy listener started'; }
        await trustMacCertificate(); completed = `${action === 'simulator-prepare' ? completed + '; ' : ''}Mac user certificate trusted`;
        await run('/usr/bin/xcrun', ['simctl', 'keychain', target, 'add-root-cert', certificatePath]); completed += '; simulator certificate installed';
        if (action === 'simulator-prepare') {
          try { await performAction({ action: 'mac-enable-proxy', target: networkTarget }); }
          catch (error) {
            if (error.code !== 'PROXY_PERMISSION') throw error;
            return { message: `${completed}. The system proxy was not changed: ${error.message} Simulator apps follow the Mac's system proxy, so either ask IT to set the HTTP/HTTPS proxy to 127.0.0.1:${proxyPort}, or point the app under test at the Streamglass proxy itself. Then add API domains to the TLS allowlist.`, partial: true, devices: await list() };
          }
        }
      } catch (error) { throw new Error(`${completed}. Setup did not finish: ${error.message}`); }
      if (action === 'simulator-certificates') return { message: 'Mac user and simulator certificates installed. System proxy settings are unchanged. Configure the proxy inside your app or ask IT to configure the network proxy, then add API domains to the TLS allowlist.', devices: await list() };
      return { message: 'Simulator capture prepared. Mac monitor stays enabled across app restarts. Add API domains to the TLS allowlist, then reload the simulator app. Existing capture pause is unchanged.', devices: await list() };
    }
    if (action === 'mac-trust-ca') {
      if (platform !== 'darwin') throw new Error('macOS required');
      await trustMacCertificate();
    } else if (action === 'simulator-install-ca') {
      requireTarget(devices.simulators);
      if (devices.simulators.find(item => item.id === target).state !== 'Booted') throw new Error('Boot the selected simulator first');
      await run('/usr/bin/xcrun', ['simctl', 'keychain', target, 'add-root-cert', certificatePath]);
      return { message: `Certificate installed in ${devices.simulators.find(item => item.id === target).name}. Enable Mac capture on the active network and add the intended domains to the TLS allowlist, then reload the simulator app or page.`, devices: await list() };
    } else if (['android-reverse', 'android-reverse-remove'].includes(action)) {
      requireTarget(devices.android);
      const adb = await adbPath();
      if (!adb) throw new Error('adb unavailable');
      // Ports are fixed integers (the proxy port and Metro's default); nothing from the caller reaches the command line except the validated serial.
      const ports = [proxyPort, ...(metro === true ? [8081] : [])];
      for (const port of [...new Set(ports)]) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
        try { await run(adb, action === 'android-reverse' ? ['-s', target, 'reverse', `tcp:${port}`, `tcp:${port}`] : ['-s', target, 'reverse', '--remove', `tcp:${port}`]); }
        catch (error) { if (action === 'android-reverse' || !/not found|no such reverse/i.test(`${error.message} ${error.stderr ?? ''}`)) throw error; }
      }
      const portList = [...new Set(ports)].join(' and ');
      return { message: action === 'android-reverse' ? `adb reverse active for port ${portList}. Set the device proxy to 127.0.0.1:${proxyPort}; the app reaches this Mac through the USB tunnel. Reversals end when the device disconnects or adb restarts.` : `adb reverse removed for port ${portList}.`, devices: await list() };
    } else if (action === 'android-install-ca') {
      requireTarget(devices.android);
      const adb = await adbPath();
      if (!adb) throw new Error('adb unavailable');
      await run(adb, ['-s', target, 'push', certificatePath, '/sdcard/Download/streamglass-ca.cer']);
      await run(adb, ['-s', target, 'shell', 'am', 'start', '-a', 'android.settings.SECURITY_SETTINGS']);
      return { message: 'Certificate copied to Downloads. In Settings choose Install a certificate → CA certificate and select streamglass-ca.cer.' };
    } else if (['mac-enable-proxy', 'mac-restore-proxy'].includes(action)) {
      if (platform !== 'darwin') throw new Error('macOS required');
      const override = target || null;
      target = target || devices.activeNetworkId;
      if (action === 'mac-enable-proxy') requireTarget(devices.networkServices);
      const key = `mac:${target}`;
      const types = ['web', 'secureweb'];
      if (action === 'mac-enable-proxy') {
        if (networkOnly) {
          const current = await Promise.all(types.map(type => run('/usr/sbin/networksetup', [`-get${type}proxy`, target])));
          devices.networkServices.find(service => service.id === target).proxyEnabled = current.every(text => /^Enabled: Yes$/m.test(text) && /^Server: 127\.0\.0\.1$/m.test(text) && new RegExp(`^Port: ${proxyPort}$`, 'm').test(text));
        }
        if (!networkOnly) await ensureProxyListening();
        if (!state[key]) {
          state[key] = {};
          for (const type of types) {
            const text = await run('/usr/sbin/networksetup', [`-get${type}proxy`, target]);
            const fields = Object.fromEntries(text.split('\n').map(line => { const i = line.indexOf(': '); return [line.slice(0, i), line.slice(i + 2)]; }));
            if (fields['Authenticated Proxy Enabled'] === '1') throw new Error('Authenticated proxies require manual configuration');
            if (!['Yes', 'No'].includes(fields.Enabled) || !/^\d+$/.test(fields.Port)) throw new Error('Cannot read previous proxy configuration');
            state[key][type] = { enabled: fields.Enabled === 'Yes', host: fields.Server, port: fields.Port };
          }
          await save(state);
        }
        if (state[key].appliedPort !== proxyPort) { state[key].appliedPort = proxyPort; await save(state); }
        if (!devices.networkServices.find(item => item.id === target)?.proxyEnabled) await configureNetwork(types.flatMap(type => [ ['/usr/sbin/networksetup', `-set${type}proxy`, target, '127.0.0.1', String(proxyPort)], ['/usr/sbin/networksetup', `-set${type}proxystate`, target, 'on'] ]), !restoring);
        await verifyNetwork(target, Object.fromEntries(types.map(type => [type, { enabled: true, host: '127.0.0.1', port: String(proxyPort) }])));
        if (!restoring) { await saveIntent({ enabled: true, override }); scheduleMonitor(); }
        lastNetwork = target;
        monitorError = '';
        if (networkOnly) return;
      } else {
        clearInterval(timer); timer = undefined;
        await saveIntent({ enabled: false, override: null });
        const failures = await restoreMacProxies(state, { onlyOwned });
        monitorError = failures.join('\n');
        if (failures.length) throw new Error(`Monitoring is disabled. Some saved proxies still need restoration; retry Disable Mac capture. ${monitorError}`);

      }
    } else throw new Error('Unknown device action');
    return { message: action === 'mac-enable-proxy' ? `Mac monitor enabled on ${target} and follows network changes automatically unless an advanced override is selected. It will reconnect after app restarts. Open an app or reload a page to capture new connections.` : action === 'mac-restore-proxy' ? 'Mac monitor disabled; saved proxy settings restored on all monitored networks.' : action === 'mac-trust-ca' ? 'Certificate trusted. Enable Mac capture separately to route traffic through Streamglass.' : 'Completed', devices: await list() };
  }
  const enqueue = task => { const result = pending.then(task); pending = result.catch(() => {}); return result; };
  function scheduleMonitor() {
    if (suspended || timer || platform !== 'darwin') return;
    timer = setInterval(() => {
      if (monitorTickPending) return;
      monitorTickPending = true;
      void enqueue(reconcileMonitor).catch(error => { monitorError = error.message; }).finally(() => { monitorTickPending = false; });
    }, 5000);
    timer.unref?.();
  }
  let lastNetwork;
  async function reconcileMonitor(force = false) {
    if (suspended) return;
    const intent = await readIntent();
    if (!intent?.enabled || platform !== 'darwin') return;
    let network = await networks();
    if (!network.activeNetworkId && !intent.override) network = await networks(true);
    const target = intent.override || network.activeNetworkId;
    if (!target) { lastNetwork = null; monitorError = network.networkNotice; return; }
    if (!force && target === lastNetwork) return;
    // Network changes never restart a listener stopped by the user during this session.
    lastNetwork = target;
    try {
      await performAction({ action: 'mac-enable-proxy', target, restoring: true, networkOnly: true });
      monitorError = '';
    } catch (error) { monitorError = error.message; throw error; }
  }
  async function restoreMonitor({ startListener = true } = {}) {
    suspended = false;
    await setup.start();
    return enqueue(async () => {
      let intent = await readIntent();
      if (!intent) {
        if (!Object.keys(await readState()).some(key => key.startsWith('mac:'))) return;
        const inventory = await list();
        if (!inventory.networkServices.some(item => item.canRestore && item.proxyEnabled)) return;
        intent = { enabled: true, override: null };
      } else if (!Object.hasOwn(intent, 'enabled')) intent = { enabled: Boolean(intent.target), override: null };
      await saveIntent(intent);
      if (!intent.enabled) return;
      scheduleMonitor();
      try { if (startListener) await ensureProxyListening(); await reconcileMonitor(true); } catch (error) { monitorError = error.message; throw error; }
    });
  }
  async function monitorStatus() {
    const [intent, state] = await Promise.all([readIntent(), readState()]);
    return { ...observedNetwork, monitorEnabled: Boolean(intent?.enabled), monitorOverride: intent?.override ?? null, monitorError, savedProxyTargets: Object.keys(state) };
  }
  const setup = createDeviceSetup({ dataDir, certificatePath, proxyPort, adbPath, run, optional, readState, saveState: save, enqueue, performAction, ensureProxyListening, getLanInfo, emit: emitInventory, metroProbe, macMonitorEnabled: async () => Boolean((await readIntent())?.enabled) });
  async function prepareQuit() {
    suspended = true;
    clearInterval(timer); timer = undefined;
    return enqueue(async () => {
      const deviceResult = await setup.prepareQuit();
      const state = await readState();
      const macErrors = platform === 'darwin' ? await restoreMacProxies(state, { automatic: true }) : [];
      const errors = [...macErrors];
      if (!deviceResult.ok) errors.push(deviceResult.message);
      monitorError = errors.join('\n');
      // A simulator entry only records that it owns the Mac proxy (the simulator itself keeps no proxy).
      // Once the Mac proxy is restored it is stale; drop it so it doesn't block quit or confuse the next launch.
      let remaining = await readState();
      if (!macErrors.length && !Object.keys(remaining).some(key => key.startsWith('mac:'))) {
        const simulators = Object.keys(remaining).filter(key => key.startsWith('ios-simulator:'));
        if (simulators.length) { for (const key of simulators) delete remaining[key]; await save(remaining); remaining = await readState(); }
      }
      const deferred = new Set(deviceResult.deferredTargets);
      return {remainingProxyTargets:Object.keys(remaining).filter(key => !deferred.has(key)), errors};
    });
  }
  // releaseSystemProxy restores system proxies that still point here and pauses monitoring until restoreMonitor.
  return { setup, list, monitorStatus, restoreMonitor, prepareQuit, releaseSystemProxy: prepareQuit, reconcileMonitor: (force = false) => enqueue(() => reconcileMonitor(force)), dispose: async () => { suspended = true; clearInterval(timer); setup.dispose(); await pending; }, perform: input => {
    if (input?.action === 'android-enable-proxy') return setup.connect({ platform: 'android', id: input.target, ...(input.metro === undefined ? {} : { metro: input.metro }) }).then(async result => {
      if (!result.ok) throw new Error(result.message);
      return { ...result, devices: await list() };
    });
    if (input?.action === 'android-restore-proxy') return setup.disconnect({ platform: 'android', id: input.target }).then(async result => ({ ...result, devices: await list() }));
    return enqueue(async () => {
      try { return await performAction(input); } catch (error) { monitorError = error.message; throw error; }
    });
  } };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeviceService } from '../electron/devices.mjs';

async function fixture(t, { route4 = 'en0', route6 = 'en0', failElevation = false, authenticated = false, captured = false, simulators = null, directNetwork = false, failSimulator = false, genericDenial = false, ensureProxyListening = async () => {}, groups = 'staff admin', noOpWrites = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'streamglass-devices-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const services = [];
  const commands = [];
  const proxies = new Map();
  const proxyState = (target, type) => {
    const key = `${target}:${type}`;
    if (!proxies.has(key)) proxies.set(key, { enabled: captured || type === 'web', host: captured ? '127.0.0.1' : 'previous.example', port: captured ? '8080' : '3128' });
    return proxies.get(key);
  };
  const applyNetworkChange = args => {
    if (noOpWrites) return;
    const type = args[0].includes('secureweb') ? 'secureweb' : 'web';
    const proxy = proxyState(args[1], type);
    if (args[0].endsWith('proxystate')) proxy.enabled = args[2] === 'on';
    else { proxy.host = args[2]; proxy.port = args[3]; }
  };
  const executeCommand = async (file, args) => {
    commands.push([file, ...args]);
    if (file.endsWith('/id')) { if (groups === null) throw new Error('Cannot read groups'); return { stdout: groups }; }
    if (file.endsWith('/security')) return { stdout: '' };
    if (file.endsWith('/xcrun') && failSimulator && args.includes('add-root-cert')) throw new Error('Simulator trust denied');
    if (file.endsWith('/xcrun') && simulators !== null) return { stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: simulators } }) : '' };
    if (file.endsWith('/networksetup')) {
      if (args[0] === '-listallnetworkservices') return { stdout: 'An asterisk denotes disabled services.\nAX88179B USB\nWi-Fi\nVPN\n*Disabled\n' };
      if (args[0] === '-listnetworkserviceorder') return { stdout: '(1) AX88179B USB\n(Hardware Port: USB, Device: en9)\n(2) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n(3) VPN\n(Hardware Port: VPN, Device: utun7)' };
      if (args[0].startsWith('-set')) { if (!directNetwork) throw new Error(genericDenial ? `Command failed: /usr/sbin/networksetup ${args.join(' ')}` : 'Requires root privileges'); applyNetworkChange(args); return { stdout: '' }; }
      if (args[0].startsWith('-get')) { const proxy = proxyState(args[1], args[0].includes('secureweb') ? 'secureweb' : 'web'); return { stdout: `Enabled: ${proxy.enabled ? 'Yes' : 'No'}\nServer: ${proxy.host}\nPort: ${proxy.port}\nAuthenticated Proxy Enabled: ${authenticated ? '1' : '0'}` }; }
    }
    if (file.endsWith('/route')) {
      const device = args.includes('-inet6') ? route6 : route4;
      if (!device) throw new Error('No route');
      return { stdout: `route to: default\n interface: ${device}\n` };
    }
    if (file.endsWith('/osascript')) {
      if (failElevation) throw new Error('User cancelled');
      for (const command of args[1].split(' && ')) { const values = [...command.matchAll(/'([^']*)'/g)].map(match => match[1]); if (values[0]?.endsWith('/networksetup')) applyNetworkChange(values.slice(1)); }
      return { stdout: '' };
    }
    throw new Error('Tool not installed');
  };
  const restart = () => { const service = createDeviceService({ dataDir, certificatePath: path.join(dataDir, 'ca.pem'), proxyPort: 8080, getProxyHost: () => '192.0.2.1', platform: 'darwin', ensureProxyListening, executeCommand }); services.push(service); return service; };
  t.after(() => services.forEach(service => service.dispose()));
  return { commands, dataDir, service: restart(), restart, setNoOpWrites: value => { noOpWrites = value; }, setRoute: (ipv4, ipv6 = ipv4) => { route4 = ipv4; route6 = ipv6; }, proxyState };
}

test('Mac setup selects the active interface rather than the first network service', async t => {
  const { service, commands } = await fixture(t);
  const devices = await service.list();
  assert.equal(devices.activeNetworkId, 'Wi-Fi');
  assert.equal(devices.networkServices.find(item => item.id === 'Wi-Fi').interface, 'en0');
  assert.equal(devices.networkServices.length, 3);
  assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
});

test('different IP routes and unknown VPN routes require explicit selection', async t => {
  for (const options of [{ route6: 'en9' }, { route4: 'utun99', route6: null }, { route4: null, route6: null }]) {
    const { service, commands } = await fixture(t, options);
    const devices = await service.list();
    assert.equal(devices.activeNetworkId, null);
    await assert.rejects(service.perform({ action: 'mac-enable-proxy' }), /Select an available/);
    assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
  }
});

test('enabling changes only the chosen service and restores its original proxy settings', async t => {
  const { service, commands, dataDir } = await fixture(t, { route6: null });
  await service.perform({ action: 'mac-enable-proxy' });
  const saved = JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['mac:Wi-Fi']);
  assert.deepEqual(saved['mac:Wi-Fi'].secureweb, { enabled: false, host: 'previous.example', port: '3128' });
  await service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), saved);
  await service.perform({ action: 'mac-restore-proxy', target: 'Wi-Fi' });
  const elevated = commands.filter(command => command[0].endsWith('/osascript')).map(command => command[2]);
  assert.equal(elevated.length, 2);
  assert.ok(elevated.every(command => command.includes('Wi-Fi') && !command.includes('AX88179B USB') && !command.includes('VPN')));
  assert.match(elevated[1], /previous.example/);
  assert.match(elevated[1], /-setsecurewebproxystate.*off/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), {});
});

test('cancelled administrator request keeps the restoration snapshot', async t => {
  const { service, dataDir } = await fixture(t, { failElevation: true });
  await assert.rejects(service.perform({ action: 'mac-enable-proxy' }), /User cancelled/);
  const devices = await service.list();
  assert.equal(devices.networkServices.find(item => item.id === 'Wi-Fi').canRestore, true);
  assert.equal(devices.monitorEnabled, false);
  assert.ok(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'))['mac:Wi-Fi']);
});

test('authenticated existing proxies are never overwritten', async t => {
  const { service, commands } = await fixture(t, { authenticated: true });
  await assert.rejects(service.perform({ action: 'mac-enable-proxy' }), /Authenticated proxies/);
  assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
});

test('capture status requires both system proxy types to use this Streamglass port', async t => {
  const { service } = await fixture(t, { captured: true });
  const devices = await service.list();
  assert.equal(devices.networkServices.find(item => item.id === 'Wi-Fi').proxyEnabled, true);
  assert.equal(devices.networkServices.find(item => item.id === 'Wi-Fi').canRestore, false);
});

test('manual network selection works when default routes disagree', async t => {
  const { service, commands } = await fixture(t, { route6: 'en9' });
  await service.perform({ action: 'mac-enable-proxy', target: 'AX88179B USB' });
  const command = commands.find(command => command[0].endsWith('/osascript'))[2];
  assert.match(command, /AX88179B USB/);
  assert.equal(command.includes('Wi-Fi'), false);
});


test('simulator setup distinguishes missing tools, shut down devices and booted devices', async t => {
  const unavailable = await fixture(t);
  assert.match((await unavailable.service.list()).simulatorNotice, /tools are unavailable/);
  const stopped = await fixture(t, { simulators: [{ udid: 'sim-stopped', name: 'Stopped phone', state: 'Shutdown' }] });
  assert.match((await stopped.service.list()).simulatorNotice, /No booted simulator/);
  await writeFile(path.join(stopped.dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----');
  await assert.rejects(stopped.service.perform({ action: 'simulator-install-ca', target: 'sim-stopped' }), /Boot the selected simulator/);
  assert.equal(stopped.commands.some(command => command.includes('add-root-cert')), false);
  const booted = await fixture(t, { simulators: [{ udid: 'sim-booted', name: 'Booted phone', state: 'Booted' }] });
  await writeFile(path.join(booted.dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----');
  const result = await booted.service.perform({ action: 'simulator-install-ca', target: 'sim-booted' });
  assert.match(result.message, /Enable Mac capture on the active network/);
  assert.ok(booted.commands.some(command => command.includes('keychain') && command.includes('sim-booted') && command.includes('add-root-cert')));
  assert.equal(booted.commands.some(command => command[0].endsWith('/osascript')), false);
});


test('single simulator action trusts user and simulator certificates and persists monitoring', async t => {
  let starts = 0;
  const { service, commands, dataDir } = await fixture(t, { simulators: [{ udid: 'sim', name: 'Phone', state: 'Booted' }], directNetwork: true, ensureProxyListening: async () => { starts++; } });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  const result = await service.perform({ action: 'simulator-prepare', target: 'sim', networkTarget: 'Wi-Fi' });
  assert.match(result.message, /Simulator capture prepared/);
  assert.ok(starts > 0);
  const trust = commands.find(command => command.includes('add-trusted-cert'));
  assert.ok(trust.some(value => value.endsWith('login.keychain-db')));
  assert.ok(!trust.includes('-d'));
  assert.ok(commands.some(command => command.includes('add-root-cert') && command.includes('sim')));
  assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'mac-monitor.json'), 'utf8')), { enabled: true, override: 'Wi-Fi' });
  await service.restoreMonitor();
  assert.equal((await service.list()).monitorTarget, 'Wi-Fi');
  await service.perform({ action: 'mac-restore-proxy', target: 'Wi-Fi' });
  assert.equal((await service.list()).monitorTarget, null);
  const before = commands.length;
  await service.restoreMonitor();
  assert.equal(commands.length, before);
});

test('startup restores listener without prompting when the existing proxy already matches', async t => {
  let starts = 0;
  const { service, commands, dataDir } = await fixture(t, { captured: true, ensureProxyListening: async () => { starts++; } });
  await writeFile(path.join(dataDir, 'mac-monitor.json'), JSON.stringify({ target: 'Wi-Fi' }));
  await service.restoreMonitor();
  assert.equal(starts, 1);
  assert.equal(commands.some(command => command[0].endsWith('/osascript') || command[1]?.startsWith('-set')), false);
});

test('startup reports administrator requirement without opening an authentication dialog', async t => {
  const { service, commands, dataDir } = await fixture(t);
  await writeFile(path.join(dataDir, 'mac-monitor.json'), JSON.stringify({ target: 'Wi-Fi' }));
  await assert.rejects(service.restoreMonitor(), /without permission/);
  assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
  assert.equal((await service.list()).monitorTarget, 'Wi-Fi');
});

test('simulator preparation rejects stopped devices before any certificate or proxy change', async t => {
  const { service, commands, dataDir } = await fixture(t, { simulators: [{ udid: 'sim', name: 'Phone', state: 'Shutdown' }] });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  await assert.rejects(service.perform({ action: 'simulator-prepare', target: 'sim' }), /Boot the selected/);
  assert.equal(commands.some(command => command.includes('add-trusted-cert') || command.includes('add-root-cert') || command[1]?.startsWith('-set')), false);
});


test('monitor intent survives a new device service while restoration settings stay intact', async t => {
  let starts = 0;
  const { service, restart, dataDir } = await fixture(t, { directNetwork: true, ensureProxyListening: async () => { starts++; } });
  await service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' });
  const original = await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8');
  await restart().restoreMonitor();
  assert.equal(starts, 2);
  assert.equal(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'), original);
  await restart().perform({ action: 'mac-restore-proxy', target: 'Wi-Fi' });
  await restart().restoreMonitor();
  assert.equal(starts, 2);
});

test('legacy snapshots migrate only when the system still points to Streamglass', async t => {
  for (const captured of [true, false]) {
    let starts = 0;
    const { service, dataDir } = await fixture(t, { captured, ensureProxyListening: async () => { starts++; } });
    await writeFile(path.join(dataDir, 'device-proxy-state.json'), JSON.stringify({ 'mac:Wi-Fi': { web: {}, secureweb: {} } }));
    await service.restoreMonitor();
    assert.equal(starts, captured ? 1 : 0);
    assert.equal((await service.list()).monitorTarget, captured ? 'Wi-Fi' : null);
  }
});

test('simulator setup reports completed steps when simulator certificate installation fails', async t => {
  const { service, commands, dataDir } = await fixture(t, { failSimulator: true, simulators: [{ udid: 'sim', name: 'Phone', state: 'Booted' }] });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  await assert.rejects(service.perform({ action: 'simulator-prepare', target: 'sim' }), /Proxy listener started; Mac user certificate trusted.*Setup did not finish: Simulator trust denied/);
  assert.equal(commands.some(command => command[1]?.startsWith('-set')), false);
  assert.equal((await service.list()).monitorTarget, null);
});


test('failed combined proxy preparation keeps original snapshot without claiming persistent monitor ownership', async t => {
  const { service, dataDir, commands } = await fixture(t, { failElevation: true, simulators: [{ udid: 'sim', name: 'Phone', state: 'Booted' }] });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  const result = await service.perform({ action: 'simulator-prepare', target: 'sim', networkTarget: 'Wi-Fi' });
  assert.equal(result.partial, true);
  assert.match(result.message, /simulator certificate installed\. The system proxy was not changed: macOS requires administrator approval/);
  const original = JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'));
  assert.deepEqual(original['mac:Wi-Fi'].secureweb, { enabled: false, host: 'previous.example', port: '3128' });
  assert.equal((await service.list()).monitorEnabled, false);
  const before = commands.filter(command => command[1]?.startsWith('-set')).length;
  await service.restoreMonitor();
  assert.equal(commands.filter(command => command[1]?.startsWith('-set')).length, before);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), original);
});


test('standard or unknown account never receives an administrator prompt on permission denial', async t => {
  for (const groups of ['staff everyone', null]) {
    const { service, commands } = await fixture(t, { groups });
    await assert.rejects(service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' }), /This account cannot change system proxy settings.*Ask IT/);
    assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
    assert.equal((await service.list()).monitorEnabled, false);
  }
});

test('standard account can install user and simulator certificates without changing network proxies', async t => {
  const { service, dataDir, commands } = await fixture(t, { groups: 'staff', simulators: [{ udid: 'sim', name: 'Phone', state: 'Booted' }] });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  const result = await service.perform({ action: 'simulator-certificates', target: 'sim' });
  assert.match(result.message, /System proxy settings are unchanged/);
  assert.ok(commands.some(command => command.includes('add-trusted-cert')));
  assert.ok(commands.some(command => command.includes('add-root-cert')));
  assert.equal(commands.some(command => command[0].endsWith('/osascript') || command[1]?.startsWith('-set')), false);
});

test('standard account combined setup completes certificates and reports the skipped system proxy without prompting for admin', async t => {
  const { service, dataDir, commands } = await fixture(t, { groups: 'staff', simulators: [{ udid: 'sim', name: 'Phone', state: 'Booted' }] });
  await writeFile(path.join(dataDir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture');
  const result = await service.perform({ action: 'simulator-prepare', target: 'sim' });
  assert.equal(result.partial, true);
  assert.match(result.message, /Mac user certificate trusted; simulator certificate installed\. The system proxy was not changed: This account cannot change system proxy settings.*127\.0\.0\.1:8080/);
  assert.equal(commands.some(command => command[0].endsWith('/osascript')), false);
});

test('an unexplained networksetup failure still reaches the administrator prompt for admins and is handled for standard accounts', async t => {
  const admin = await fixture(t, { groups: 'staff admin', genericDenial: true });
  await admin.service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' });
  assert.equal(admin.commands.some(command => command[0].endsWith('/osascript')), true);
  const standard = await fixture(t, { groups: 'staff', genericDenial: true });
  await assert.rejects(standard.service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' }), /This account cannot change system proxy settings/);
  assert.equal(standard.commands.some(command => command[0].endsWith('/osascript')), false);
});


test('successful exit from a no-op network command cannot claim monitor ownership', async t => {
  const { service, dataDir } = await fixture(t, { directNetwork: true, noOpWrites: true });
  await assert.rejects(service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' }), /did not match the requested configuration/);
  assert.equal((await service.list()).monitorEnabled, false);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'));
  assert.deepEqual(saved['mac:Wi-Fi'].web, { enabled: true, host: 'previous.example', port: '3128' });
});

test('a no-op restore disables monitoring and retains original settings for recovery', async t => {
  const { service, dataDir, setNoOpWrites } = await fixture(t, { directNetwork: true });
  await service.perform({ action: 'mac-enable-proxy', target: 'Wi-Fi' });
  const original = await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8');
  setNoOpWrites(true);
  await assert.rejects(service.perform({ action: 'mac-restore-proxy', target: 'Wi-Fi' }), /did not match the requested configuration/);
  assert.equal((await service.list()).monitorEnabled, false);
  assert.equal(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'), original);
  setNoOpWrites(false);
  await service.perform({ action: 'mac-restore-proxy', target: 'Wi-Fi' });
  assert.equal((await service.list()).monitorTarget, null);
});


test('automatic monitor follows Wi-Fi to Ethernet without device inventory or listener restart', async t => {
  let starts = 0;
  const { service, commands, dataDir, setRoute, proxyState } = await fixture(t, { directNetwork: true, ensureProxyListening: async () => { starts++; } });
  await service.perform({ action: 'mac-enable-proxy' });
  const before = commands.length;
  setRoute('en9');
  await service.reconcileMonitor();
  assert.equal(starts, 1);
  assert.equal(proxyState('AX88179B USB', 'web').host, '127.0.0.1');
  assert.equal(commands.slice(before).some(command => command[0].endsWith('/xcrun') || command.includes('devices') || command.includes('-listallnetworkservices')), false);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'))).sort(), ['mac:AX88179B USB', 'mac:Wi-Fi']);
  await service.perform({ action: 'mac-restore-proxy' });
  assert.equal(proxyState('AX88179B USB', 'web').host, 'previous.example');
  assert.equal(proxyState('Wi-Fi', 'web').host, 'previous.example');
  const after = commands.length;
  await service.reconcileMonitor();
  assert.equal(commands.length, after);
});

test('background permission failure keeps automatic intent without an administrator dialog', async t => {
  const { service, commands, dataDir, setRoute } = await fixture(t);
  await service.perform({ action: 'mac-enable-proxy' });
  const before = commands.length;
  setRoute('en9');
  await assert.rejects(service.reconcileMonitor(), /without permission/);
  assert.equal(commands.slice(before).some(command => command[0].endsWith('/osascript')), false);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'mac-monitor.json'), 'utf8')).enabled, true);
  assert.ok(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'))['mac:AX88179B USB']);
});

test('disable retries every saved network after a failed restore without resuming automatic monitoring', async t => {
  const { service, dataDir, setRoute, setNoOpWrites } = await fixture(t, { directNetwork: true });
  await service.perform({ action: 'mac-enable-proxy' });
  setRoute('en9'); await service.reconcileMonitor();
  setNoOpWrites(true);
  await assert.rejects(service.perform({ action: 'mac-restore-proxy' }), /Some saved proxies still need restoration/);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'mac-monitor.json'), 'utf8')).enabled, false);
  assert.equal(Object.keys(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'))).length, 2);
  setNoOpWrites(false);
  await service.perform({ action: 'mac-restore-proxy' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), {});
});

test('quit restores every monitored Mac network and keeps the next-launch preference', async t => {
  const { service, restart, commands, dataDir, setRoute, proxyState } = await fixture(t, { directNetwork: true });
  await service.perform({ action: 'mac-enable-proxy' });
  setRoute('en9'); await service.reconcileMonitor();
  const before = commands.length;
  assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:[], errors:[]});
  for (const target of ['Wi-Fi', 'AX88179B USB']) {
    assert.deepEqual(proxyState(target, 'web'), {enabled:true, host:'previous.example', port:'3128'});
    assert.deepEqual(proxyState(target, 'secureweb'), {enabled:false, host:'previous.example', port:'3128'});
  }
  assert.equal(commands.slice(before).some(command => command[0].endsWith('/osascript') || command[0].endsWith('/xcrun') || command.includes('devices')), false);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'mac-monitor.json'), 'utf8')).enabled, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), {});
  const after = commands.length;
  setRoute('en0'); await service.reconcileMonitor();
  assert.equal(commands.length, after);
  const next = restart(); await next.restoreMonitor();
  assert.equal(proxyState('Wi-Fi', 'web').host, '127.0.0.1');
  assert.deepEqual((await next.prepareQuit()).errors, []);
  assert.equal(proxyState('Wi-Fi', 'web').host, 'previous.example');
});

test('quit preserves externally changed proxy fields while restoring fields still owned by Streamglass', async t => {
  const { service, proxyState } = await fixture(t, { directNetwork:true });
  await service.perform({ action:'mac-enable-proxy' });
  Object.assign(proxyState('Wi-Fi', 'web'), {enabled:true, host:'it.example', port:'9000'});
  assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:[], errors:[]});
  assert.deepEqual(proxyState('Wi-Fi', 'web'), {enabled:true, host:'it.example', port:'9000'});
  assert.deepEqual(proxyState('Wi-Fi', 'secureweb'), {enabled:false, host:'previous.example', port:'3128'});
});

test('quit retains failed snapshots and never requests administrator credentials', async t => {
  for (const directNetwork of [true, false]) {
    const { service, dataDir, commands, setNoOpWrites } = await fixture(t, {directNetwork});
    await service.perform({action:'mac-enable-proxy'});
    const original = await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8');
    if (directNetwork) setNoOpWrites(true);
    const before = commands.length;
    const result = await service.prepareQuit();
    assert.deepEqual(result.remainingProxyTargets, ['mac:Wi-Fi']);
    assert.equal(result.errors.length, 1);
    assert.equal(commands.slice(before).some(command => command[0].endsWith('/osascript')), false);
    assert.equal(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'), original);
    assert.equal((await service.monitorStatus()).monitorEnabled, true);
    if (directNetwork) {
      setNoOpWrites(false);
      await service.restoreMonitor({startListener:false});
      assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:[], errors:[]});
    }
  }
});

test('quit leaves Android restoration snapshots for an explicit device restore', async t => {
  const { service, commands, dataDir } = await fixture(t, {directNetwork:true});
  await service.perform({action:'mac-enable-proxy'});
  const saved = JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8'));
  saved['android:fixture-phone'] = {http_proxy:':0'};
  await writeFile(path.join(dataDir, 'device-proxy-state.json'), JSON.stringify(saved));
  const before = commands.length;
  assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:['android:fixture-phone'], errors:[]});
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'device-proxy-state.json'), 'utf8')), {'android:fixture-phone':{http_proxy:':0'}});
  assert.equal(commands.slice(before).some(command => command[0].includes('adb')), false);
});

test('quit with no saved proxies performs no system or device queries', async t => {
  const { service, commands } = await fixture(t);
  assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:[], errors:[]});
  assert.deepEqual(commands, []);
});

test('quit disables a legacy snapshot that points back to the stopped listener', async t => {
  const { service, dataDir, proxyState } = await fixture(t, {directNetwork:true, captured:true});
  const original = {enabled:true, host:'127.0.0.1', port:'8080'};
  await writeFile(path.join(dataDir, 'device-proxy-state.json'), JSON.stringify({'mac:Wi-Fi':{web:original, secureweb:original}}));
  assert.deepEqual(await service.prepareQuit(), {remainingProxyTargets:[], errors:[]});
  assert.equal(proxyState('Wi-Fi', 'web').enabled, false);
  assert.equal(proxyState('Wi-Fi', 'secureweb').enabled, false);
});

test('quit waits for an already queued enable before restoring it', async t => {
  const { service, proxyState, commands } = await fixture(t, {directNetwork:true});
  const enabling = service.perform({action:'mac-enable-proxy'});
  const quitting = service.prepareQuit();
  await enabling;
  assert.deepEqual(await quitting, {remainingProxyTargets:[], errors:[]});
  assert.equal(proxyState('Wi-Fi', 'web').host, 'previous.example');
  const before = commands.length;
  await service.reconcileMonitor();
  assert.equal(commands.length, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationResolver, parseApplicationSockets, simulatorDeviceDirectory, simulatorRuntimeName, emulatorAvdName, parseAdbDevices, adbReverseTargets } from '../electron/applications.mjs';

const sockets = (pid = 42, source = '127.0.0.1:51234', destination = '127.0.0.1:8080') => `p${pid}\ncBrowser Helper\nf4\nn${source}->${destination}\nTST=ESTABLISHED\n`;
function fixture({ output = sockets() + sockets(9, '127.0.0.1:8080', '127.0.0.1:51234'), executable = '/Applications/Dia.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper', fail = '', icon = 'data:image/png;base64,aGVsbG8=', iconFile = '', renderedIcon = '', interfaces = { en0: [{ address: '192.168.1.8' }] }, ps = {}, plist = {}, files = {}, adb = null, commands = {} } = {}) {
  const calls = [];
  let time = 1000;
  const resolver = createApplicationResolver({
    platform: 'darwin', proxyPort: 8080, now: () => time, getNetworkInterfaces: () => interfaces,
    environment: {}, home: '/Users/example', findAdb: async () => adb,
    readFile: async file => { if (file in files) return files[file]; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    getFileIcon: async (...args) => { calls.push(['icon', ...args]); const data = typeof icon === 'function' ? await icon() : icon; return { toDataURL: () => data }; },
    executeCommand: async (file, args, options) => {
      calls.push([file, args, options]);
      if (file.includes(fail || 'never-fail')) throw new Error('Unavailable');
      if (file.endsWith('lsof')) return { stdout: typeof output === 'function' ? output() : output };
      if (file.endsWith('/ps')) return { stdout: args[3] === 'comm=' ? executable : ps[`${args[1]} ${args[3]}`] ?? '' };
      if (file === adb) { const key = args.join(' '); if (key in commands) return { stdout: commands[key] }; throw new Error('Unavailable'); }
      if (args[1] === 'Print :name' || args[1] === 'Print :runtime') return { stdout: plist[`${args[2]} ${args[1].slice(7)}`] ?? '' };
      if (file.endsWith('/osascript')) return { stdout: renderedIcon };
      if (args[1] === 'Print :CFBundleDisplayName') return { stdout: 'Dia' };
      if (args[1] === 'Print :CFBundleIdentifier') return { stdout: 'company.thebrowser.dia' };
      if (args[1] === 'Print :CFBundleIconFile' || args[1] === 'Print :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0') return { stdout: iconFile };
      return { stdout: '' };
    },
  });
  return { ...resolver, calls, advance: () => { time += 201; } };
}
const client = { clientHost: '127.0.0.1', clientPort: 51234 };

test('field parser preserves outgoing direction, IPv6 and multiple file descriptors', () => {
  const parsed = parseApplicationSockets(sockets() + sockets(9, '[::1]:8080', '[::1]:51234') + 'p7\ncListener\nf3\nn*:8080\nTST=LISTEN\n');
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].source, { host: '127.0.0.1', port: 51234 });
  assert.deepEqual(parsed[1].source, { host: '::1', port: 8080 });
});

test('a half-closed emulator socket can still be attributed to its owner', async () => {
  const output = sockets().replace('ESTABLISHED', 'FIN_WAIT_2');
  const resolver = fixture({
    output,
    executable: '/sdk/emulator/qemu-system-aarch64',
    ps: { '42 args=': '/sdk/emulator/qemu-system-aarch64 -avd Emulator_1' },
  });
  assert.equal((await resolver.resolveClient(client)).device?.id, 'android-emulator:Emulator_1');
  assert.deepEqual(parseApplicationSockets(output.replace('FIN_WAIT_2', 'TIME_WAIT')), []);
});

test('exact outgoing tuple selects the app rather than the proxy and maps outer bundle', async () => {
  const { resolve, calls } = fixture();
  const app = await resolve(client);
  assert.deepEqual(app, { id: 'app:/Applications/Dia.app', name: 'Dia', bundleId: 'company.thebrowser.dia', icon: 'data:image/png;base64,aGVsbG8=', pid: 42, kind: 'application', platform: 'mac' });
  assert.deepEqual(calls.find(call => call[0].endsWith('/ps'))[1], ['-p', '42', '-o', 'comm=']);
  const lsof = calls.find(call => call[0].endsWith('/lsof'));
  assert.deepEqual(lsof[1], ['-nP', '-iTCP:8080', '-FpcfnT']);
  assert.equal(lsof[2].timeout, 5000);
  assert.equal(calls.find(call => call[0].endsWith('/ps'))[2].timeout, 2000);
  assert.deepEqual(calls.find(call => call[0] === 'icon').slice(1), ['/Applications/Dia.app', { size: 'small' }]);
});

test('remote peers, different source ports, nonlocal destination and ambiguous owners stay unknown', async () => {
  for (const [output, peer] of [[sockets(42, '10.15.9.2:51234'), { ...client, clientHost: '10.15.9.2' }], [sockets(), { ...client, clientPort: 1234 }], [sockets(42, '127.0.0.1:51234', '10.15.9.2:8080'), client], [sockets() + sockets(43), client]]) {
    assert.equal(await fixture({ output }).resolve(peer), null);
  }
  const { resolve, isLocalHost } = fixture({ output: sockets(42, '192.168.1.8:51234') });
  assert.equal(isLocalHost('::ffff:127.0.0.1'), true);
  assert.equal(isLocalHost('::ffff:7f00:1'), true);
  assert.equal(isLocalHost('10.15.9.2'), false);
  assert.equal((await resolve({ ...client, clientHost: '192.168.1.8' })).pid, 42);
});

test('simulator attribution is explicit and device relays never pretend to be apps', async () => {
  const simulator = fixture({ executable: '/Users/user/Library/Developer/CoreSimulator/Devices/DEVICE/data/Containers/Bundle/Application/ID/SampleApp.app/SampleApp' });
  assert.equal((await simulator.resolve(client)).platform, 'iosSimulator');
  assert.ok(simulator.calls.some(call => call[0].endsWith('PlistBuddy') && call[1][2].endsWith('/SampleApp.app/Info.plist')));
  for (const executable of ['/opt/android/platform-tools/adb', '/opt/android/emulator/emulator', '/opt/android/emulator/qemu-system-aarch64']) {
    assert.equal(await fixture({ executable }).resolve(client), null);
  }
});

test('concurrent lookups share bounded socket and process work; next snapshot observes PID churn', async () => {
  let pid = 42;
  const { resolve, calls, advance } = fixture({ output: () => sockets(pid) });
  await Promise.all(Array.from({ length: 20 }, () => resolve(client)));
  assert.equal(calls.filter(call => call[0].endsWith('/lsof')).length, 1);
  assert.equal(calls.filter(call => call[0].endsWith('/ps')).length, 1);
  pid = 43;
  advance();
  assert.equal((await resolve(client)).pid, 43);
  assert.equal(calls.filter(call => call[0].endsWith('/ps')).length, 2);
  assert.equal(calls.filter(call => call[0] === 'icon').length, 1);
});

test('closed sockets and unavailable process tools degrade to unknown; icons are optional and constrained', async () => {
  for (const options of [{ output: '' }, { fail: 'lsof' }, { fail: '/ps' }, { executable: '' }]) assert.equal(await fixture(options).resolve(client), null);
  for (const icon of ['https://example.com/icon.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'a'.repeat(150000)}`]) assert.equal((await fixture({ icon }).resolve(client)).icon, undefined);
  const process = await fixture({ executable: '/usr/bin/curl' }).resolve(client);
  assert.deepEqual(process, { id: 'process:/usr/bin/curl', name: 'curl', pid: 42, kind: 'process' });
  assert.equal((await fixture({ executable: 'node' }).resolve(client)).name, 'node');
});

test('a cached miss refreshes once for concurrent new connections', async () => {
  let output = sockets();
  const { resolve, calls } = fixture({ output: () => output });
  assert.equal((await resolve(client)).pid, 42);
  output += sockets(43, '127.0.0.1:51235');
  const results = await Promise.all(Array.from({ length: 20 }, () => resolve({ ...client, clientPort: 51235 })));
  assert.ok(results.every(result => result?.pid === 43));
  assert.equal(calls.filter(call => call[0].endsWith('/lsof')).length, 2);
});

test('an icon provider that never settles cannot hold up application attribution', async () => {
  const { resolve, calls } = fixture({ icon: () => new Promise(() => {}) });
  const started = Date.now();
  const application = await resolve(client);
  assert.equal(application.name, 'Dia');
  assert.equal(application.icon, undefined);
  assert.ok(Date.now() - started < 1500);
  await resolve(client);
  assert.equal(calls.filter(call => call[0] === 'icon').length, 1);
});

test('the complete lookup has a deadline even when a process runner never settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resolver = createApplicationResolver({ platform: 'darwin', proxyPort: 8080, executeCommand: () => new Promise(() => {}) });
  const result = resolver.resolve(client);
  t.mock.timers.tick(10000);
  assert.equal(await result, null);
});

test('bundle-declared icon assets take precedence over generic file icons', async () => {
  const mac = fixture({ iconFile: 'app.icns', renderedIcon: 'aWNvbg==' });
  assert.equal((await mac.resolve(client)).icon, 'data:image/png;base64,aWNvbg==');
  assert.equal(mac.calls.some(call => call[0] === 'icon'), false);
  assert.ok(mac.calls.find(call => call[0].endsWith('/osascript'))[1].includes('/Applications/Dia.app/Contents/Resources/app.icns'));
  const simulator = fixture({ executable: '/Users/user/Library/Developer/CoreSimulator/Devices/ID/SampleApp.app/SampleApp', iconFile: 'AppIcon-Staging60x60', renderedIcon: 'c2lt' });
  assert.equal((await simulator.resolve(client)).icon, 'data:image/png;base64,c2lt');
  assert.ok(simulator.calls.find(call => call[0].endsWith('/osascript'))[1].some(value => value.endsWith('/SampleApp.app/AppIcon-Staging60x60@2x.png')));
});

test('invalid bundle icon paths are ignored and failed rendering keeps file-icon fallback', async () => {
  for (const iconFile of ['../outside.icns', '/outside.icns', 'bad\nicon', 'bad\0icon', 'code.js', '']) {
    const resolver = fixture({ iconFile, renderedIcon: 'c2lt' });
    assert.equal((await resolver.resolve(client)).icon, 'data:image/png;base64,aGVsbG8=');
    assert.equal(resolver.calls.some(call => call[0].endsWith('/osascript')), false);
  }
  const resolver = fixture({ iconFile: 'app.icns', fail: '/osascript' });
  assert.equal((await resolver.resolve(client)).icon, 'data:image/png;base64,aGVsbG8=');
});

test('stored app icons resolve without a live process and reject non-bundle IDs', async () => {
  const resolver = fixture({ iconFile: 'app.icns', renderedIcon: 'aWNvbg==' });
  assert.deepEqual(await resolver.resolveIcon('app:/Applications/Dia.app'), { id: 'app:/Applications/Dia.app', icon: 'data:image/png;base64,aWNvbg==' });
  assert.equal(resolver.calls.some(call => /\/(lsof|ps)$/.test(call[0])), false);
  for (const id of ['process:/bin/curl', 'app:relative.app', 'app:/Applications/../Outside.app', 'app:/etc/passwd', 'app:/Bad\0.app']) assert.equal(await resolver.resolveIcon(id), null);
});

// Synthetic simulator, emulator and adb identities; none come from a real machine.
const UDID = '00000000-0000-4000-8000-000000000001';
const DEVICE_DIR = `/Users/example/Library/Developer/CoreSimulator/Devices/${UDID}`;
const simulatorPlist = { [`${DEVICE_DIR}/device.plist name`]: 'iPhone Example', [`${DEVICE_DIR}/device.plist runtime`]: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0' };

test('device helpers parse simulator folders, runtimes, AVD names and adb output', () => {
  assert.deepEqual(simulatorDeviceDirectory(`${DEVICE_DIR}/data/Containers/Bundle/Application/X/App.app/App`), { directory: DEVICE_DIR, udid: UDID.toUpperCase() });
  assert.equal(simulatorDeviceDirectory(`/Users/example/Library/Developer/XCTestDevices/${UDID}/data/var/run/launchd_bootstrap.plist`).udid, UDID.toUpperCase());
  for (const text of ['/Users/example/Library/Developer/CoreSimulator/Devices/DEVICE/App.app/App', `relative/CoreSimulator/Devices/${UDID}/x`, `/a/../CoreSimulator/Devices/${UDID}/x`, null]) assert.equal(simulatorDeviceDirectory(text), null);
  assert.equal(simulatorRuntimeName('com.apple.CoreSimulator.SimRuntime.iOS-18-0'), 'iOS 18.0');
  assert.equal(simulatorRuntimeName('com.apple.CoreSimulator.SimRuntime.watchOS-11-2-1'), 'watchOS 11.2.1');
  assert.equal(simulatorRuntimeName('garbage'), null);
  assert.equal(emulatorAvdName('/opt/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -netdelay none -avd Example_Phone_API_35 -port 5554'), 'Example_Phone_API_35');
  assert.equal(emulatorAvdName('/opt/sdk/emulator/emulator @Example_Tablet'), 'Example_Tablet');
  for (const args of ['/opt/qemu-system-aarch64 -port 5554', '/opt/qemu -avd ../escape', '/opt/qemu -avd bad/name', null]) assert.equal(emulatorAvdName(args), null);
  assert.deepEqual(parseAdbDevices('List of devices attached\nemulator-5554 device product:sdk model:sdk_gphone64 device:emu64a transport_id:1\nEXAMPLE01 unauthorized usb:1\nEXAMPLE02 device usb:2 model:Example_Phone transport_id:2\nbad;serial device\n'),
    [{ serial: 'emulator-5554', model: 'sdk gphone64' }, { serial: 'EXAMPLE02', model: 'Example Phone' }]);
  assert.equal(adbReverseTargets('EXAMPLE02 tcp:8080 tcp:8080\n', 8080), true);
  assert.equal(adbReverseTargets('EXAMPLE02 tcp:8081 tcp:8081\n', 8080), false);
});

test('Mac apps and processes carry no device, so the Mac stays the client address', async () => {
  assert.deepEqual((await fixture().resolveClient(client)).device, null);
  assert.deepEqual(await fixture({ executable: '/usr/bin/curl' }).resolveClient(client), { application: { id: 'process:/usr/bin/curl', name: 'curl', pid: 42, kind: 'process' }, device: null });
  assert.deepEqual(await fixture({ output: '' }).resolveClient(client), { application: null, device: null });
});

test('simulator apps name their simulator from the device folder in the executable path', async () => {
  const resolver = fixture({ executable: `${DEVICE_DIR}/data/Containers/Bundle/Application/X/SampleApp.app/SampleApp`, plist: simulatorPlist });
  const { application, device } = await resolver.resolveClient(client);
  assert.equal(application.platform, 'iosSimulator');
  assert.deepEqual(device, { id: `ios-simulator:${UDID.toUpperCase()}`, name: 'iPhone Example (iOS 18.0)', kind: 'iosSimulator', platform: 'ios' });
  // The existing application-only API is unchanged.
  assert.equal((await resolver.resolve(client)).name, 'Dia');
});

test('simulator runtime processes find their simulator through the launchd_sim parent', async () => {
  const runtime = '/Library/Developer/CoreSimulator/Volumes/iOS_X/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.0.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.Networking.xpc/com.apple.WebKit.Networking';
  const resolver = fixture({ executable: runtime, plist: simulatorPlist, ps: { '42 ppid=': '700', '700 args=': `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim ${DEVICE_DIR}/data/var/run/launchd_bootstrap.plist` } });
  assert.equal((await resolver.resolveClient(client)).device.id, `ios-simulator:${UDID.toUpperCase()}`);
  const orphan = fixture({ executable: runtime, ps: { '42 ppid=': '1' } });
  assert.deepEqual((await orphan.resolveClient(client)).device, { id: 'ios-simulator:unknown', name: 'iOS Simulator', kind: 'iosSimulator', platform: 'ios' });
});

test('emulator relays name the AVD without pretending to be an app', async () => {
  const qemu = '/opt/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64';
  const args = { '42 args=': `${qemu} -netdelay none -avd Example_Phone_API_35 -port 5554` };
  const named = fixture({ executable: qemu, ps: args, files: { '/Users/example/.android/avd/Example_Phone_API_35.avd/config.ini': 'hw.ramSize=2048\navd.ini.displayname=Example Phone API 35\n' } });
  assert.deepEqual(await named.resolveClient(client), { application: null, device: { id: 'android-emulator:Example_Phone_API_35', name: 'Example Phone API 35', kind: 'androidEmulator', platform: 'android' } });
  assert.equal(await named.resolve(client), null);
  assert.equal((await fixture({ executable: qemu, ps: args }).resolveClient(client)).device.name, 'Example Phone API 35');
  assert.equal((await fixture({ executable: qemu }).resolveClient(client)).device.id, 'android-emulator:unknown');
});

test('the shared netsimd relay names the emulator only when one AVD is running', async () => {
  const netsimd = '/opt/sdk/emulator/netsimd';
  const qemu = '/opt/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless';
  const resolver = (processes, args) => createApplicationResolver({
    platform: 'darwin', proxyPort: 8080, environment: {}, home: '/Users/example', readFile: async () => { throw new Error('missing'); },
    executeCommand: async (file, commandArgs) => {
      if (file.endsWith('lsof')) return { stdout: sockets() };
      if (commandArgs[0] === '-axo') return { stdout: processes };
      if (commandArgs[3] === 'comm=') return { stdout: netsimd };
      if (commandArgs[3] === 'args=') return { stdout: args[commandArgs[1]] ?? '' };
      return { stdout: '' };
    },
  });
  const single = resolver(`  42 ${netsimd}\n  700 ${qemu}\n  701 /usr/bin/login`, { 700: `${qemu} -avd Example_Phone_API_35 -port 5554` });
  assert.deepEqual(await single.resolveClient(client), { application: null, device: { id: 'android-emulator:Example_Phone_API_35', name: 'Example Phone API 35', kind: 'androidEmulator', platform: 'android' } });
  const two = resolver(`  700 ${qemu}\n  800 ${qemu}`, { 700: `${qemu} -avd Example_Phone_API_35`, 800: `${qemu} -avd Example_Tablet` });
  assert.equal((await two.resolveClient(client)).device.id, 'android-emulator:unknown');
  assert.equal((await resolver('', {}).resolveClient(client)).device.id, 'android-emulator:unknown');
});

test('adb reverse attributes to the one device reversing the proxy port, else a shared adb device', async () => {
  const adb = '/opt/sdk/platform-tools/adb';
  const listing = 'List of devices attached\nemulator-5554 device model:sdk_gphone64\nEXAMPLE02 device usb:2 model:Example_Phone\n';
  const phone = fixture({ executable: adb, adb, commands: { 'devices -l': listing, '-s emulator-5554 reverse --list': '', '-s EXAMPLE02 reverse --list': 'EXAMPLE02 tcp:8080 tcp:8080' } });
  assert.deepEqual(await phone.resolveClient(client), { application: null, device: { id: 'android-device:EXAMPLE02', name: 'Example Phone', kind: 'androidDevice', platform: 'android' } });
  const emulator = fixture({ executable: adb, adb, commands: { 'devices -l': listing, '-s emulator-5554 reverse --list': 'host-1 tcp:8080 tcp:8080', '-s EXAMPLE02 reverse --list': '', '-s emulator-5554 emu avd name': 'Example_Phone_API_35\nOK' } });
  assert.equal((await emulator.resolveClient(client)).device.id, 'android-emulator:Example_Phone_API_35');
  const both = fixture({ executable: adb, adb, commands: { 'devices -l': listing, '-s emulator-5554 reverse --list': 'host-1 tcp:8080 tcp:8080', '-s EXAMPLE02 reverse --list': 'EXAMPLE02 tcp:8080 tcp:8080' } });
  assert.equal((await both.resolveClient(client)).device.id, 'android-device:adb');
  // Without the SDK's adb the socket owner's binary is never executed.
  const missing = fixture({ executable: adb });
  assert.equal((await missing.resolveClient(client)).device.id, 'android-device:adb');
  assert.equal(missing.calls.some(call => call[0] === adb), false);
});

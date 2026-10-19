import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationResolver, parseApplicationSockets } from '../electron/applications.mjs';

const sockets = (pid = 42, source = '127.0.0.1:51234', destination = '127.0.0.1:8080') => `p${pid}\ncBrowser Helper\nf4\nn${source}->${destination}\nTST=ESTABLISHED\n`;
function fixture({ output = sockets() + sockets(9, '127.0.0.1:8080', '127.0.0.1:51234'), executable = '/Applications/Dia.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper', fail = '', icon = 'data:image/png;base64,aGVsbG8=', iconFile = '', renderedIcon = '', interfaces = { en0: [{ address: '192.168.1.8' }] } } = {}) {
  const calls = [];
  let time = 1000;
  const resolver = createApplicationResolver({
    platform: 'darwin', proxyPort: 8080, now: () => time, getNetworkInterfaces: () => interfaces,
    getFileIcon: async (...args) => { calls.push(['icon', ...args]); const data = typeof icon === 'function' ? await icon() : icon; return { toDataURL: () => data }; },
    executeCommand: async (file, args, options) => {
      calls.push([file, args, options]);
      if (file.includes(fail || 'never-fail')) throw new Error('Unavailable');
      if (file.endsWith('lsof')) return { stdout: typeof output === 'function' ? output() : output };
      if (file.endsWith('/ps')) return { stdout: executable };
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

test('exact outgoing tuple selects the app rather than the proxy and maps outer bundle', async () => {
  const { resolve, calls } = fixture();
  const app = await resolve(client);
  assert.deepEqual(app, { id: 'app:/Applications/Dia.app', name: 'Dia', bundleId: 'company.thebrowser.dia', icon: 'data:image/png;base64,aGVsbG8=', pid: 42, kind: 'application', platform: 'mac' });
  assert.deepEqual(calls.find(call => call[0].endsWith('/ps'))[1], ['-p', '42', '-o', 'comm=']);
  const lsof = calls.find(call => call[0].endsWith('/lsof'));
  assert.deepEqual(lsof[1], ['-nP', '-iTCP:8080', '-sTCP:ESTABLISHED', '-FpcfnT']);
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

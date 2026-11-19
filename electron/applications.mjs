import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { readFile as readTextFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const execute = promisify(execFile);
// AppKit decodes bundle ICNS and simulator PNG assets without relying on a generic file icon.
const renderIcon = `ObjC.import('AppKit'); function run(paths) {
  for (const file of paths) {
    const source = $.NSImage.alloc.initWithContentsOfFile(file);
    if (!source || source.isValid !== true) continue;
    const image = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
    image.lockFocus;
    source.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
    image.unlockFocus;
    const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
    return ObjC.unwrap(bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0));
  }
  return '';
}`;
const pngData = data => typeof data === 'string' && data.length <= 128 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data) ? data : undefined;
async function bounded(promise, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]); }
  finally { clearTimeout(timer); }
}
const portNumber = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
const hostAddress = value => {
  if (typeof value !== 'string') return null;
  let host = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.startsWith('::ffff:') && isIP(host.slice(7)) === 4) host = host.slice(7);
  if (!isIP(host)) return null;
  if (isIP(host) === 6 && !host.includes('%')) {
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
    const mapped = host.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
    if (mapped) return [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join('.');
  }
  return host;
};
const endpoint = value => {
  const match = value.match(/^(.*):(\d+)$/);
  return match ? { host: hostAddress(match[1]), port: portNumber(match[2]) } : null;
};

// Loopback clients share 127.0.0.1, so the socket's owning process tells simulators and emulators apart from the Mac.
// Device identity is display data only: it never changes LAN-guard policy, which keys on the client address.
const SIMULATOR_DEVICE = /^(\/.*\/(?:CoreSimulator\/Devices|XCTestDevices)\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}))(?:\/|$)/i;
const deviceText = (value, limit = 128) => typeof value === 'string' && value.trim() && value.trim().length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
export function simulatorDeviceDirectory(text) {
  const match = typeof text === 'string' ? text.match(SIMULATOR_DEVICE) : null;
  return match && !match[1].split('/').includes('..') ? { directory: match[1], udid: match[2].toUpperCase() } : null;
}
export function simulatorRuntimeName(runtime) {
  const match = typeof runtime === 'string' ? runtime.match(/SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/) : null;
  return match ? `${match[1]} ${match[2].replaceAll('-', '.')}` : null;
}
const AVD_NAME = /^[A-Za-z0-9._-]{1,128}$/;
export function emulatorAvdName(args) {
  if (typeof args !== 'string') return null;
  const tokens = args.split(/\s+/);
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index] === '-avd' ? tokens[index + 1] : tokens[index].startsWith('@') ? tokens[index].slice(1) : null;
    if (name && AVD_NAME.test(name) && name !== '.' && name !== '..') return name;
  }
  return null;
}
export function parseAdbDevices(output) {
  const devices = [];
  for (const line of (output ?? '').split('\n').slice(1)) {
    const [serial, state, ...details] = line.trim().split(/\s+/);
    if (state !== 'device' || !/^[\w.:@-]{1,200}$/.test(serial ?? '')) continue;
    const model = details.find(item => item.startsWith('model:'))?.slice(6);
    devices.push({ serial, model: model && /^[\w.-]{1,64}$/.test(model) ? model.replaceAll('_', ' ') : null });
  }
  return devices;
}
export function adbReverseTargets(output, proxyPort) {
  // `adb reverse --list` prints "<serial-or-transport> <device side> <host side>"; the host side reaches this proxy.
  return (output ?? '').split('\n').some(line => line.trim().split(/\s+/).at(-1) === `tcp:${proxyPort}`);
}

// A client can half-close before lsof runs while the socket still has a process owner.
const attributableTcpStates = ['ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSING', 'LAST_ACK'];

export function parseApplicationSockets(output) {
  const sockets = [];
  let pid, command, socket;
  const flush = () => { if (socket?.attributable && socket.source?.host && socket.destination?.host) sockets.push(socket); socket = null; };
  for (const line of output.split('\n')) {
    const field = line.slice(1);
    if (line[0] === 'p') { flush(); pid = /^\d+$/.test(field) ? Number(field) : null; command = ''; }
    else if (line[0] === 'c') command = field;
    else if (line[0] === 'f') { flush(); socket = pid ? { pid, command } : null; }
    else if (line[0] === 'n' && socket) {
      const pair = field.split('->');
      if (pair.length === 2) { socket.source = endpoint(pair[0]); socket.destination = endpoint(pair[1]); }
    } else if (line.startsWith('TST=') && socket) socket.attributable = attributableTcpStates.includes(line.slice(4));
  }
  flush();
  return sockets;
}

export function createApplicationResolver({ getFileIcon, proxyPort, executeCommand = execute, getNetworkInterfaces = networkInterfaces, platform = process.platform, now = Date.now, readFile = readTextFile, findAdb = async () => null, environment = process.env, home = homedir() } = {}) {
  const snapshots = new Map();
  const bundles = new Map();
  const devices = new Map();
  const run = async (file, args) => (await executeCommand(file, args, { timeout: file.endsWith('/lsof') ? 5000 : 2000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })).stdout.trim();
  const optional = async (file, args) => { try { return await run(file, args); } catch { return null; } };
  const remember = (cache, key, value, limit) => { cache.delete(key); cache.set(key, value); if (cache.size > limit) cache.delete(cache.keys().next().value); return value; };
  const isLocal = host => host && (host === '::1' || host.startsWith('127.') || Object.values(getNetworkInterfaces()).flat().some(item => item && hostAddress(item.address) === host));
  async function snapshot(port, refresh = false) {
    const previous = snapshots.get(port);
    if (previous && (previous.pending || (!refresh && now() - previous.time < 200))) return previous.result;
    const entry = { time: now(), pending: true };
    entry.result = optional('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-FpcfnT'])
      .then(output => ({ sockets: output ? parseApplicationSockets(output) : [], processes: new Map() }))
      .finally(() => { entry.pending = false; entry.time = now(); });
    remember(snapshots, port, entry, 4);
    return entry.result;
  }
  async function bundleInfo(bundle) {
    const cached = bundles.get(bundle);
    if (cached && now() - cached.time < 300000) return cached.result;
    const result = (async () => {
      const simulator = bundle.includes('/CoreSimulator/');
      const plist = path.join(bundle, simulator ? 'Info.plist' : 'Contents/Info.plist');
      const [displayName, bundleName, bundleId, iconFile] = await Promise.all(['CFBundleDisplayName', 'CFBundleName', 'CFBundleIdentifier', simulator ? 'CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0' : 'CFBundleIconFile'].map(key => optional('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])));
      const info = { name: displayName || bundleName || path.basename(bundle, '.app') };
      if (bundleId && /^[\w.-]{1,255}$/.test(bundleId)) info.bundleId = bundleId;
      if (iconFile && iconFile.length <= 255 && !/[\/\\\r\n\0]/.test(iconFile) && iconFile !== '.' && iconFile !== '..' && (!path.extname(iconFile) || /\.(png|icns)$/i.test(iconFile))) {
        const files = simulator ? [iconFile, ...['@2x.png', '@3x.png', '.png'].map(suffix => iconFile.replace(/\.png$/i, '') + suffix)] : [iconFile, iconFile + '.icns'];
        const directory = simulator ? bundle : path.join(bundle, 'Contents/Resources');
        const rendered = await optional('/usr/bin/osascript', ['-l', 'JavaScript', '-e', renderIcon, ...files.map(file => path.join(directory, file))]);
        info.icon = pngData(rendered ? `data:image/png;base64,${rendered}` : undefined);
      }
      try {
        if (!info.icon) {
          const icon = await bounded(Promise.resolve().then(() => getFileIcon?.(bundle, { size: 'small' })), 200);
          const data = pngData(icon?.toDataURL());
          if (data) info.icon = data;
        }
      } catch { /* Application identity remains useful without an icon. */ }
      return info;
    })();
    remember(bundles, bundle, { time: now(), result }, 128);
    return result;
  }
  const cachedDevice = (key, ttl, compute) => {
    const cached = devices.get(key);
    if (cached && now() - cached.time < ttl) return cached.result;
    const result = compute().catch(() => null);
    remember(devices, key, { time: now(), result }, 64);
    return result;
  };
  const plistValue = async (file, key) => deviceText(await optional('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]));
  function simulatorDevice(found) {
    return cachedDevice(`simulator:${found.directory}`, 300000, async () => {
      const plist = path.join(found.directory, 'device.plist');
      const [name, runtime] = await Promise.all([plistValue(plist, 'name'), plistValue(plist, 'runtime')]);
      const version = simulatorRuntimeName(runtime);
      const label = name ? (version ? `${name} (${version})` : name) : version ? `${version} Simulator` : 'iOS Simulator';
      return { id: `ios-simulator:${found.udid}`, name: label.slice(0, 128), kind: 'iosSimulator', platform: 'ios' };
    });
  }
  async function simulatorAncestor(pid) {
    // Runtime processes (Safari, WebKit networking, nsurlsessiond) live outside the device folder; their launchd_sim
    // parent is started with the device's bootstrap plist, which names the device folder.
    let current = pid;
    for (let depth = 0; depth < 3; depth++) {
      const parent = Number(await optional('/bin/ps', ['-p', String(current), '-o', 'ppid=']));
      if (!Number.isInteger(parent) || parent <= 1) return null;
      const args = await optional('/bin/ps', ['-p', String(parent), '-o', 'args=']);
      const bootstrap = args?.match(/^\S*\blaunchd_sim\s+(\/.+)$/);
      if (bootstrap) return simulatorDeviceDirectory(bootstrap[1]);
      current = parent;
    }
    return null;
  }
  async function avdDisplayName(avd) {
    const roots = [environment.ANDROID_AVD_HOME, environment.ANDROID_USER_HOME && path.join(environment.ANDROID_USER_HOME, 'avd'), path.join(home, '.android/avd')];
    for (const root of roots.filter(root => typeof root === 'string' && path.isAbsolute(root))) {
      try {
        const text = await readFile(path.join(root, `${avd}.avd`, 'config.ini'), 'utf8');
        const name = deviceText(text.match(/^avd\.ini\.displayname\s*=\s*(.+)$/m)?.[1]);
        if (name) return name;
      } catch { /* Try the next AVD home. */ }
    }
    return avd.replaceAll('_', ' ');
  }
  const emulatorDevice = avd => cachedDevice(`avd:${avd}`, 300000, async () => ({ id: `android-emulator:${avd}`, name: (await avdDisplayName(avd)).slice(0, 128), kind: 'androidEmulator', platform: 'android' }));
  const emulatorUnknown = { id: 'android-emulator:unknown', name: 'Android Emulator', kind: 'androidEmulator', platform: 'android' };
  function runningEmulator() {
    // Newer emulators route guest networking (10.0.2.2) through one shared netsimd daemon, so the socket names no AVD;
    // attribute it when exactly one AVD is running, otherwise show a shared emulator device rather than the Mac.
    return cachedDevice('netsim', 3000, async () => {
      const listing = await optional('/bin/ps', ['-axo', 'pid=,comm=']);
      const pids = (listing ?? '').split('\n').map(line => line.trim().match(/^(\d+)\s+(.+)$/))
        .filter(match => match && /^(emulator|qemu-system-[\w-]+)$/.test(path.basename(match[2]))).map(match => match[1]).slice(0, 8);
      const avds = new Set();
      for (const pid of pids) { const avd = emulatorAvdName(await optional('/bin/ps', ['-p', pid, '-o', 'args='])); if (avd) avds.add(avd); }
      return avds.size === 1 ? emulatorDevice([...avds][0]) : emulatorUnknown;
    });
  }
  const adbFallback = { id: 'android-device:adb', name: 'Android (adb reverse)', kind: 'androidDevice', platform: 'android' };
  function adbDevice(port) {
    // The adb server relays every reversed device through one Mac socket; attribute it only when exactly one online
    // device reverses the proxy port, otherwise show a shared adb device rather than the Mac.
    return cachedDevice(`adb:${port}`, 3000, async () => {
      const adb = await findAdb();
      if (!adb || !path.isAbsolute(adb)) return adbFallback;
      const online = parseAdbDevices(await optional(adb, ['devices', '-l']));
      const reversed = [];
      for (const device of online.slice(0, 16)) if (adbReverseTargets(await optional(adb, ['-s', device.serial, 'reverse', '--list']), port)) reversed.push(device);
      if (reversed.length !== 1) return adbFallback;
      const [{ serial, model }] = reversed;
      if (serial.startsWith('emulator-')) {
        const avd = (await optional(adb, ['-s', serial, 'emu', 'avd', 'name']))?.split('\n')[0]?.trim();
        if (avd && AVD_NAME.test(avd)) return emulatorDevice(avd);
      }
      return { id: `android-device:${serial}`, name: (model || serial).slice(0, 128), kind: 'androidDevice', platform: 'android' };
    });
  }
  async function identify(socket) {
    const executable = await optional('/bin/ps', ['-p', String(socket.pid), '-o', 'comm=']);
    if (!executable || executable.includes('\n') || (!path.isAbsolute(executable) && executable.includes('/'))) return { application: null, device: null };
    const base = path.basename(executable);
    // Device relays own Mac sockets without identifying the app on the other device; they still name the device.
    if (/^(emulator|qemu-system-[\w-]+)$/.test(base)) {
      const avd = emulatorAvdName(await optional('/bin/ps', ['-p', String(socket.pid), '-o', 'args=']));
      return { application: null, device: avd ? await emulatorDevice(avd) : emulatorUnknown };
    }
    if (base === 'netsimd') return { application: null, device: await runningEmulator() };
    if (base === 'adb') return { application: null, device: portNumber(socket.destination?.port) ? await adbDevice(socket.destination.port) : adbFallback };
    const simulator = executable.includes('/CoreSimulator/');
    const found = simulator ? simulatorDeviceDirectory(executable) ?? await simulatorAncestor(socket.pid) : null;
    const device = found ? await simulatorDevice(found) : simulator ? { id: 'ios-simulator:unknown', name: 'iOS Simulator', kind: 'iosSimulator', platform: 'ios' } : null;
    const bundle = executable.match(/^(.+?\.app)\//)?.[1];
    if (bundle) return { application: { id: `app:${bundle}`, ...(await bundleInfo(bundle)), pid: socket.pid, kind: 'application', platform: simulator ? 'iosSimulator' : 'mac' }, device };
    return { application: { id: `process:${executable}`, name: base, pid: socket.pid, kind: 'process' }, device };
  }
  async function lookup({ clientHost, clientPort, proxyPort: requestedPort = proxyPort } = {}) {
    const host = hostAddress(clientHost), sourcePort = portNumber(clientPort), port = portNumber(requestedPort);
    if (platform !== 'darwin' || !host || !sourcePort || !port || !isLocal(host)) return null;
    try {
      const previous = snapshots.get(port);
      const reused = previous && !previous.pending && now() - previous.time < 200;
      let current = await snapshot(port);
      const match = sockets => sockets.filter(socket => socket.source.host === host && socket.source.port === sourcePort && socket.destination.port === port && isLocal(socket.destination.host));
      let matches = match(current.sockets);
      if (!matches.length && reused) { current = await snapshot(port, true); matches = match(current.sockets); }
      const { processes } = current;
      const pids = new Set(matches.map(socket => socket.pid));
      if (pids.size !== 1) return null;
      const socket = matches[0];
      if (!processes.has(socket.pid)) processes.set(socket.pid, identify(socket));
      return await processes.get(socket.pid);
    } catch { return null; }
  }
  const unknown = { application: null, device: null };
  async function resolveIcon(id) {
    if (platform !== 'darwin' || typeof id !== 'string' || id.length > 4096 || !id.startsWith('app:') || !id.endsWith('.app')) return null;
    const bundle = id.slice(4);
    if (!path.isAbsolute(bundle) || path.normalize(bundle) !== bundle || /[\r\n\0]/.test(bundle)) return null;
    const { icon } = await bundleInfo(bundle);
    return { id, ...(icon ? { icon } : {}) };
  }
  const resolveClient = async input => (await bounded(lookup(input), 10000)) ?? unknown;
  return { resolve: async input => (await resolveClient(input)).application, resolveClient, resolveIcon: id => bounded(resolveIcon(id), 10000), isLocalHost: host => Boolean(isLocal(hostAddress(host))) };
}

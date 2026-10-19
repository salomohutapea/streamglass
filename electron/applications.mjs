import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';

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

export function parseApplicationSockets(output) {
  const sockets = [];
  let pid, command, socket;
  const flush = () => { if (socket?.established && socket.source?.host && socket.destination?.host) sockets.push(socket); socket = null; };
  for (const line of output.split('\n')) {
    const field = line.slice(1);
    if (line[0] === 'p') { flush(); pid = /^\d+$/.test(field) ? Number(field) : null; command = ''; }
    else if (line[0] === 'c') command = field;
    else if (line[0] === 'f') { flush(); socket = pid ? { pid, command } : null; }
    else if (line[0] === 'n' && socket) {
      const pair = field.split('->');
      if (pair.length === 2) { socket.source = endpoint(pair[0]); socket.destination = endpoint(pair[1]); }
    } else if (line === 'TST=ESTABLISHED' && socket) socket.established = true;
  }
  flush();
  return sockets;
}

export function createApplicationResolver({ getFileIcon, proxyPort, executeCommand = execute, getNetworkInterfaces = networkInterfaces, platform = process.platform, now = Date.now } = {}) {
  const snapshots = new Map();
  const bundles = new Map();
  const run = async (file, args) => (await executeCommand(file, args, { timeout: file.endsWith('/lsof') ? 5000 : 2000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })).stdout.trim();
  const optional = async (file, args) => { try { return await run(file, args); } catch { return null; } };
  const remember = (cache, key, value, limit) => { cache.delete(key); cache.set(key, value); if (cache.size > limit) cache.delete(cache.keys().next().value); return value; };
  const isLocal = host => host && (host === '::1' || host.startsWith('127.') || Object.values(getNetworkInterfaces()).flat().some(item => item && hostAddress(item.address) === host));
  async function snapshot(port, refresh = false) {
    const previous = snapshots.get(port);
    if (previous && (previous.pending || (!refresh && now() - previous.time < 200))) return previous.result;
    const entry = { time: now(), pending: true };
    entry.result = optional('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-FpcfnT'])
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
  async function identify(socket) {
    const executable = await optional('/bin/ps', ['-p', String(socket.pid), '-o', 'comm=']);
    if (!executable || executable.includes('\n') || (!path.isAbsolute(executable) && executable.includes('/'))) return null;
    // Device relays own Mac sockets without identifying the app on the other device.
    if (/^(adb|emulator|qemu-system-[\w-]+)$/.test(path.basename(executable))) return null;
    const bundle = executable.match(/^(.+?\.app)\//)?.[1];
    if (bundle) return { id: `app:${bundle}`, ...(await bundleInfo(bundle)), pid: socket.pid, kind: 'application', platform: executable.includes('/CoreSimulator/') ? 'iosSimulator' : 'mac' };
    return { id: `process:${executable}`, name: path.basename(executable), pid: socket.pid, kind: 'process' };
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
  async function resolveIcon(id) {
    if (platform !== 'darwin' || typeof id !== 'string' || id.length > 4096 || !id.startsWith('app:') || !id.endsWith('.app')) return null;
    const bundle = id.slice(4);
    if (!path.isAbsolute(bundle) || path.normalize(bundle) !== bundle || /[\r\n\0]/.test(bundle)) return null;
    const { icon } = await bundleInfo(bundle);
    return { id, ...(icon ? { icon } : {}) };
  }
  return { resolve: input => bounded(lookup(input), 10000), resolveIcon: id => bounded(resolveIcon(id), 10000), isLocalHost: host => Boolean(isLocal(hostAddress(host))) };
}

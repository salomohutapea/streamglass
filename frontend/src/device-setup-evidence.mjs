// Never infer a particular emulator from shared loopback traffic or an ambiguous adb id.
export function deviceEvidence(records, { ids = [], addresses = [], platform, since = 0 } = {}) {
  const timestamp = record => typeof record.startedAt === 'number' ? (record.startedAt < 1e12 ? record.startedAt * 1000 : record.startedAt) : Date.parse(record.startedAt ?? '');
  const matching = records.filter(record => {
    const time = timestamp(record);
    if (since && (!Number.isFinite(time) || time < since)) return false;
    if (ids.length || addresses.length) return ids.includes(record.deviceId) || addresses.includes(record.device);
    return record.clientIsLocal === false && (!record.devicePlatform || record.devicePlatform === platform);
  });
  const decrypted = matching.filter(r => r.sslInspected && r.kind !== 'tunnel' && !r.isEncrypted && !r.tlsFailure && (r.status ?? r.statusCode));
  const failures = matching.filter(r => r.tlsFailure);
  const bundleUrl = r => { try { const url = new URL(r.url); return url.port === '8081' && /\.bundle$/.test(url.pathname) && (r.status ?? r.statusCode) === 200 ? url : null; } catch { return null; } };
  const bundles = matching.filter(bundleUrl);
  const lastBundle = bundles.length ? bundles.reduce((a, b) => timestamp(b) >= timestamp(a) ? b : a) : null;
  const firstRecord = matching.length ? matching.reduce((a, b) => timestamp(b) < timestamp(a) ? b : a) : null;
  const lastFailure = failures.length ? failures.reduce((a, b) => timestamp(b) >= timestamp(a) ? b : a) : null;
  const duration = lastBundle && (lastBundle.durationMs ?? lastBundle.duration);
  return {
    traffic: matching.length > 0,
    tlsVerified: decrypted.length > 0,
    https: failures.length && Math.max(...failures.map(timestamp)) >= Math.max(-Infinity, ...decrypted.map(timestamp)) ? 'error' : decrypted.length ? 'ok' : 'pending',
    metro: bundles.length > 0,
    count: matching.length,
    bundle: lastBundle ? { name: bundleUrl(lastBundle).pathname.split('/').pop(), status: 200, size: typeof lastBundle.responseSize === 'number' ? lastBundle.responseSize : null, durationMs: typeof duration === 'number' ? duration : null } : null,
    failure: lastFailure ? { host: lastFailure.host ?? (() => { try { return new URL(lastFailure.url).hostname; } catch { return null; } })(), app: lastFailure.application?.name ?? null } : null,
    first: firstRecord && Number.isFinite(timestamp(firstRecord)) ? { at: timestamp(firstRecord), app: firstRecord.application?.name ?? null } : null,
  };
}
// soleProxiedEmulator: only emulators Streamglass connected send to its proxy, so with exactly one connected the
// shared "unknown emulator" captures (several AVDs running behind one netsim socket) must be this one.
export function androidRecordIds(device, { soleProxiedEmulator = false } = {}) {
  return device.kind === 'emulator' ? [`android-emulator:${device.serial}`, `android-emulator:${device.name}`, `android-device:${device.serial}`, ...(soleProxiedEmulator ? ['android-emulator:unknown'] : [])] : [`android-device:${device.serial}`];
}
/** "com.apple.CoreSimulator.SimRuntime.iOS-18-2" -> "iOS 18.2"; iPad simulators read "iPadOS". */
export function simulatorRuntimeLabel({ name = '', runtime = '' } = {}) {
  const match = /(iOS|tvOS|watchOS|xrOS|visionOS)-(\d+(?:-\d+)*)/.exec(runtime);
  if (!match) return runtime;
  const family = match[1] === 'iOS' && /ipad/i.test(name) ? 'iPadOS' : match[1];
  return `${family} ${match[2].split('-').join('.')}`;
}
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function formatAgo(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

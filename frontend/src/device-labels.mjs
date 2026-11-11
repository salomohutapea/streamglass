export const deviceLabelsKey = 'streamglass.deviceLabels';
export const deviceIcons = ['auto', 'android', 'ios', 'mac', 'generic'];

export function readDeviceLabels(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, label]) =>
      label && typeof label.name === 'string' && label.name.length <= 80 &&
      /^#[0-9a-f]{6}$/i.test(label.color) && deviceIcons.includes(label.icon)));
  } catch { return {}; }
}

export function trafficDevices(records) {
  const devices = new Map();
  for (const record of records) {
    const id = record.deviceId ?? record.device;
    if (!id) continue;
    if (!devices.has(id)) devices.set(id, { id, platforms: new Set() });
    if (['android', 'ios', 'mac'].includes(record.devicePlatform)) devices.get(id).platforms.add(record.devicePlatform);
  }
  return [...devices.values()].map(({ id, platforms }) => ({ id, platform: platforms.size === 1 ? [...platforms][0] : 'generic' }));
}

// Keeps sidebar devices where they were: known devices hold their slot (even while they have no records), and new
// ones are appended, oldest first request first. `devices` and `records` arrive newest-first from the engine.
export function stableDeviceOrder(devices, previousOrder = [], records = []) {
  const known = new Set(previousOrder), firstSeen = new Map();
  for (const record of records) {
    const id = record.deviceId ?? record.device;
    if (!id || known.has(id)) continue;
    const at = Number(record.startedAt) || 0;
    if (!firstSeen.has(id) || at < firstSeen.get(id)) firstSeen.set(id, at);
  }
  // Array.sort is stable, so ties keep the reversed (oldest-first) arrival order.
  const added = devices.map(device => device.id).filter(id => !known.has(id)).reverse()
    .sort((a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0));
  const order = [...previousOrder, ...added].slice(-512);
  const position = new Map(order.map((id, index) => [id, index]));
  return { order, devices: [...devices].sort((a, b) => position.get(a.id) - position.get(b.id)) };
}

export function incomingRecordIds(records, seen) {
  const ids = new Set(records.map(record => record.id));
  const incoming = new Set(seen === null ? [] : [...ids].filter(id => !seen.has(id)));
  return { incoming, seen: new Set([...(seen ?? []), ...ids]) };
}

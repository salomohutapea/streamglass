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

export function incomingRecordIds(records, seen) {
  const ids = new Set(records.map(record => record.id));
  const incoming = new Set(seen === null ? [] : [...ids].filter(id => !seen.has(id)));
  return { incoming, seen: new Set([...(seen ?? []), ...ids]) };
}

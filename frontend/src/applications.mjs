export const unknownApplicationId = '\u0000unknown';

export function applicationIcon(value) {
  if (typeof value !== 'string' || value.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const bytes = atob(value.slice(22));
    if (!bytes.startsWith('\x89PNG\r\n\x1a\n') || bytes.slice(12, 16) !== 'IHDR' || bytes.length < 33) return undefined;
    const dimension = offset => ((bytes.charCodeAt(offset) * 0x1000000) + (bytes.charCodeAt(offset + 1) << 16) + (bytes.charCodeAt(offset + 2) << 8) + bytes.charCodeAt(offset + 3));
    if (![dimension(16), dimension(20)].every(size => size > 0 && size <= 512)) return undefined;
    return value;
  } catch { return undefined; }
}

export function recordApplicationId(record) {
  return record.application?.id || (record.clientIsLocal === true ? unknownApplicationId : null);
}

export function trafficApplications(records) {
  const applications = new Map();
  for (const record of records) {
    const id = recordApplicationId(record);
    if (id === null) continue;
    const application = record.application;
    if (!applications.has(id)) applications.set(id, { id, name: application?.name || 'Unknown app', kind: application?.kind || 'application', icon: applicationIcon(application?.icon), count: 0 });
    const entry = applications.get(id);
    entry.count++;
    entry.icon ||= applicationIcon(application?.icon);
  }
  return [...applications.values()].sort((a, b) => a.id === unknownApplicationId ? 1 : b.id === unknownApplicationId ? -1 : a.name.localeCompare(b.name));
}

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';

const MAX_STORAGE_BYTES = 128 * 1024 * 1024;
const storageError = () => new Error('Saved workspace configurations exceed the 128 MiB aggregate storage limit');
const fields = ['tlsDomains', 'rules', 'folders', 'trafficTools', 'scenarios', 'codecs', 'productivity'];
function config(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace configuration');
  return structuredClone(Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error('Workspace name must contain 1–100 characters');
  return value.trim();
}
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid workspace request');
  if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id))) throw new Error('Invalid workspace ID');
}

export async function createWorkspaceService({ file, readConfig, applyConfig }) {
  let data = { version: 1, activeId: null, workspaces: [] };
  try {
    if ((await stat(file)).size > MAX_STORAGE_BYTES) throw storageError();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.workspaces) || saved.workspaces.length > 100) throw new Error('Invalid workspace file');
    for (const item of saved.workspaces) {
      if (!item || !item.id) throw new Error('Invalid workspace entry');
      input({ id: item.id }, ['id']); name(item.name); config(item.config);
    }
    if (new Set(saved.workspaces.map(item => item.id)).size !== saved.workspaces.length) throw new Error('Duplicate workspace IDs');
    if (saved.activeId !== null && !saved.workspaces.some(item => item.id === saved.activeId)) throw new Error('Invalid active workspace');
    data = { version: 1, activeId: saved.activeId, workspaces: saved.workspaces.map(item => ({ id: item.id, name: name(item.name), updatedAt: item.updatedAt, config: config(item.config) })) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let queue = Promise.resolve();
  const serialize = operation => { const next = queue.catch(() => {}).then(operation); queue = next; return next; };
  const list = () => ({ activeId: data.activeId, workspaces: data.workspaces.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })) });
  const find = id => { const item = data.workspaces.find(item => item.id === id); if (!item) throw new Error('Workspace not found'); return item; };
  async function persist(next) {
    // Bound before serialization so oversized fixture snapshots cannot allocate an unbounded JSON string.
    let bytes = 0;
    function measure(value) {
      if (typeof value === 'string') {
        bytes += Buffer.byteLength(value) + 2;
        if (bytes > MAX_STORAGE_BYTES) throw storageError();
        for (const character of value) {
          const code = character.charCodeAt(0);
          if (character === '\\' || character === '"' || [8, 9, 10, 12, 13].includes(code)) bytes++;
          else if (code < 32) bytes += 5;
          else if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) bytes += 3;
        }
      } else if (Array.isArray(value)) { bytes += 2 + Math.max(0, value.length - 1); for (const item of value) { measure(item); if (bytes > MAX_STORAGE_BYTES) throw storageError(); } }
      else if (value && typeof value === 'object') { bytes += 2; for (const [key, item] of Object.entries(value)) { measure(key); bytes += 2; measure(item); if (bytes > MAX_STORAGE_BYTES) throw storageError(); } }
      else bytes += JSON.stringify(value)?.length || 0;
      if (bytes > MAX_STORAGE_BYTES) throw storageError();
    }
    measure(next);
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw storageError();
    const temporary = `${file}.tmp`;
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, file);
    data = next;
    return list();
  }
  function add(next, value, snapshot, id = randomUUID()) {
    if (next.workspaces.length >= 100) throw new Error('Maximum 100 workspaces');
    const item = { id, name: value, updatedAt: new Date().toISOString(), config: snapshot };
    next.workspaces.push(item);
    return item;
  }
  return {
    list: () => serialize(() => list()),
    save: value => serialize(async () => {
      input(value, ['id', 'name']); const label = name(value.name);
      const snapshot = config(await readConfig()); const next = structuredClone(data);
      if (value.id) { find(value.id); Object.assign(next.workspaces.find(item => item.id === value.id), { name: label, config: snapshot, updatedAt: new Date().toISOString() }); next.activeId = value.id; }
      else next.activeId = add(next, label, snapshot).id;
      return persist(next);
    }),
    load: value => serialize(async () => {
      input(value, ['id']); const target = find(value.id);
      if (value.id === data.activeId) return list();
      const previous = config(await readConfig()); const next = structuredClone(data);
      const active = next.workspaces.find(item => item.id === next.activeId);
      if (active) Object.assign(active, { config: previous, updatedAt: new Date().toISOString() });
      else add(next, 'Previous configuration', previous);
      next.activeId = value.id;
      // The engine validates and replaces configuration atomically; captures and listeners stay live.
      await applyConfig(config(target.config));
      try { return await persist(next); }
      catch (error) {
        try { await applyConfig(previous); }
        catch (rollback) { throw new Error(`Workspace storage failed; restoring previous configuration also failed: ${rollback.message}`, { cause: error }); }
        throw error;
      }
    }),
    rename: value => serialize(async () => { input(value, ['id', 'name']); find(value.id); const next = structuredClone(data); next.workspaces.find(item => item.id === value.id).name = name(value.name); return persist(next); }),
    delete: value => serialize(async () => { input(value, ['id']); find(value.id); const next = structuredClone(data); next.workspaces = next.workspaces.filter(item => item.id !== value.id); if (next.activeId === value.id) next.activeId = null; return persist(next); }),
  };
}

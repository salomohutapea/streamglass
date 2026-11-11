// Rules and folders of one kind as a tree, flattened to table rows. Siblings (rules and folders together) sort by
// `order`; items without one keep their stored position, folders first. Mirrors backend/rule_folders.py, which keeps
// the stored rule list in this same order.
const FOLDER_BASE = -501;
const num = value => typeof value === 'number' && Number.isFinite(value);

function childrenByParent(rules, folders) {
  const ids = new Set(folders.map(folder => folder.id)), map = new Map();
  const add = (parent, entry) => { if (!map.has(parent)) map.set(parent, []); map.get(parent).push(entry); };
  folders.forEach((folder, index) => add(ids.has(folder.parentId) ? folder.parentId : null, { type: 'folder', id: folder.id, item: folder, order: num(folder.order) ? folder.order : FOLDER_BASE + index, index }));
  rules.forEach((rule, index) => add(ids.has(rule.folderId) ? rule.folderId : null, { type: 'rule', id: rule.id, item: rule, order: num(rule.order) ? rule.order : index + 1, index }));
  for (const list of map.values()) list.sort((a, b) => a.order - b.order || (a.type === b.type ? a.index - b.index : a.type === 'folder' ? -1 : 1));
  return map;
}

// Rows in display order. A folder row carries the number of rules below it and whether they are all on, all off or
// mixed. `visible` filters rules (search): matching rules keep their ancestor folders, which are then shown open.
export function ruleRows(rules, folders, visible) {
  const map = childrenByParent(rules, folders), rows = [];
  const walk = (parent, depth) => {
    let count = 0, on = 0, shown = 0;
    for (const entry of map.get(parent) ?? []) {
      if (entry.type === 'rule') {
        count++; if (entry.item.enabled) on++;
        if (!visible || visible(entry.item)) { rows.push({ type: 'rule', id: entry.id, depth, parentId: parent, order: entry.order, item: entry.item }); shown++; }
        continue;
      }
      const row = { type: 'folder', id: entry.id, depth, parentId: parent, order: entry.order, item: entry.item, open: visible ? true : entry.item.expanded !== false, count: 0, state: 'off' };
      const at = rows.length;
      rows.push(row);
      const open = row.open;
      const inner = walk(entry.id, depth + 1);
      row.count = inner.count;
      row.state = inner.count === 0 ? (entry.item.enabled === false ? 'off' : 'on') : inner.on === inner.count ? 'on' : inner.on === 0 ? 'off' : 'mixed';
      count += inner.count; on += inner.on;
      if (visible && !inner.shown) rows.splice(at);
      else { shown += visible ? inner.shown : 1; if (!open) rows.splice(at + 1); }
    }
    return { count, on, shown };
  };
  walk(null, 0);
  return rows;
}

// Folder ids below a folder (not including it).
export function folderDescendants(folders, id) {
  const found = new Set();
  let frontier = new Set([id]);
  while (frontier.size) {
    const next = new Set(folders.filter(folder => frontier.has(folder.parentId) && !found.has(folder.id)).map(folder => folder.id));
    next.forEach(value => found.add(value));
    frontier = next;
  }
  return found;
}

// "Outer / Inner" names for menus and the rule form.
export function folderPath(folders, id) {
  const byId = new Map(folders.map(folder => [folder.id, folder])), names = [];
  for (let cursor = byId.get(id), guard = 0; cursor && guard < 16; cursor = byId.get(cursor.parentId), guard++) names.unshift(cursor.name);
  return names.join(' / ');
}

// Where a dragged rule or folder lands: before or after the target row, or inside a target folder (appended).
// Returns { parentId, order } for the dragged item, or null when the drop is not allowed (a folder into itself or
// its own contents, or a no-op onto itself).
export function dropPlacement(rules, folders, dragged, target, zone) {
  if (dragged.id === target.id && dragged.type === target.type) return null;
  if (dragged.type === 'folder' && target.type === 'folder' && folderDescendants(folders, dragged.id).has(target.id)) return null;
  const map = childrenByParent(rules, folders), ids = new Set(folders.map(folder => folder.id));
  const targetItem = target.type === 'folder' ? folders.find(folder => folder.id === target.id) : rules.find(rule => rule.id === target.id);
  if (!targetItem) return null;
  const same = entry => entry.type === dragged.type && entry.id === dragged.id;
  if (zone === 'inside') {
    if (target.type !== 'folder') return null;
    const inside = (map.get(target.id) ?? []).filter(entry => !same(entry));
    return { parentId: target.id, order: inside.length ? inside[inside.length - 1].order + 1 : 1 };
  }
  const raw = target.type === 'folder' ? targetItem.parentId : targetItem.folderId;
  const parentId = ids.has(raw) ? raw : null;
  if (dragged.type === 'folder' && parentId && (parentId === dragged.id || folderDescendants(folders, dragged.id).has(parentId))) return null;
  const siblings = (map.get(parentId) ?? []).filter(entry => !same(entry));
  const at = siblings.findIndex(entry => entry.type === target.type && entry.id === target.id);
  if (at < 0) return null;
  const here = siblings[at].order, other = zone === 'before' ? siblings[at - 1]?.order : siblings[at + 1]?.order;
  return { parentId, order: other === undefined ? here + (zone === 'before' ? -1 : 1) : (here + other) / 2 };
}

// Keyboard reordering: one step up or down among the item's own siblings. Null at either end.
export function stepPlacement(rules, folders, item, direction) {
  const map = childrenByParent(rules, folders);
  for (const siblings of map.values()) {
    const at = siblings.findIndex(entry => entry.type === item.type && entry.id === item.id);
    if (at < 0) continue;
    const neighbour = siblings[at + direction];
    return neighbour ? dropPlacement(rules, folders, item, { type: neighbour.type, id: neighbour.id }, direction < 0 ? 'before' : 'after') : null;
  }
  return null;
}

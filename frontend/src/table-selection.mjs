// Pure selection helpers for the traffic table (synthetic ids only).
export function toggleId(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
export function rangeIds(orderedIds, anchorId, targetId) {
  const from = orderedIds.indexOf(anchorId), to = orderedIds.indexOf(targetId);
  if (to < 0) return new Set();
  if (from < 0) return new Set([targetId]);
  return new Set(orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1));
}
export function moveId(orderedIds, currentId, key) {
  if (!orderedIds.length) return null;
  if (key === 'Home') return orderedIds[0];
  if (key === 'End') return orderedIds[orderedIds.length - 1];
  const index = orderedIds.indexOf(currentId);
  if (index < 0) return key === 'ArrowUp' ? orderedIds[orderedIds.length - 1] : orderedIds[0];
  const next = Math.max(0, Math.min(orderedIds.length - 1, index + (key === 'ArrowUp' ? -1 : 1)));
  return orderedIds[next];
}
export function pruneIds(selected, validIds) {
  const valid = new Set(validIds);
  const next = new Set([...selected].filter(id => valid.has(id)));
  return next.size === selected.size ? selected : next;
}
// Click handling: returns {selected:Set, anchor:string, primary:string}
export function clickSelection({orderedIds, selected, anchor, id, shift, toggle}) {
  if (shift && anchor) return {selected: rangeIds(orderedIds, anchor, id), anchor, primary: id};
  if (toggle) {
    const next = toggleId(selected, id);
    return {selected: next, anchor: id, primary: next.has(id) ? id : ([...next].pop() ?? id)};
  }
  return {selected: new Set([id]), anchor: id, primary: id};
}

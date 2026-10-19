// Combines per-condition search results with AND/OR. AND binds tighter than OR.
export const MAX_CONDITIONS = 8;
export const MAX_EXTRA_CONDITIONS = MAX_CONDITIONS - 1;
const SCOPES = ['url', 'request', 'response', 'event'];
const MODES = ['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'wildcard'];

export function isActiveCondition(condition) {
  return Boolean(condition && typeof condition.filter === 'string' && condition.filter !== '');
}

// Keeps only well-formed extra conditions from untrusted saved data.
export function normalizeExtraConditions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (result.length >= MAX_EXTRA_CONDITIONS) break;
    if (!item || typeof item !== 'object') continue;
    if (!SCOPES.includes(item.scope) || !MODES.includes(item.mode) || typeof item.filter !== 'string') continue;
    result.push({ joiner: item.joiner === 'or' ? 'or' : 'and', scope: item.scope, mode: item.mode, filter: item.filter.slice(0, 1024) });
  }
  return result;
}

// conditions: [{joiner, filter}] where the first joiner is ignored; idSets[i] is the id Set matching condition i.
// Conditions with empty text are ignored. Returns null when no condition is active (no filtering).
export function combineConditionMatches(conditions, idSets) {
  const groups = [];
  conditions.forEach((condition, index) => {
    if (!isActiveCondition(condition)) return;
    const ids = idSets[index];
    if (!ids) return;
    if (!groups.length || condition.joiner === 'or') groups.push([ids]);
    else groups[groups.length - 1].push(ids);
  });
  if (!groups.length) return null;
  const result = new Set();
  for (const group of groups) {
    const [first, ...rest] = group;
    for (const id of first) if (rest.every(set => set.has(id))) result.add(id);
  }
  return result;
}

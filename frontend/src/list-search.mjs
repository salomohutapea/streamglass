export function matchesListSearch(query, values) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = values.filter(value => value != null).join(' ').toLowerCase();
  return terms.every(term => text.includes(term));
}

export function matchesRuleSearch(rule, query, folders = []) {
  return matchesListSearch(query, [rule.name, rule.pattern, rule.method, rule.method === '*' ? 'any' : '',
    ...(rule.stages ?? []).map(stage => stage === 'event' ? 'event SSE' : stage),
    folders.find(folder => folder.id === rule.folderId)?.name,
    rule.enabled ? 'enabled' : 'disabled', rule.script]);
}

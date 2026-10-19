export function upsertRule(rules, updated) {
  const index = rules.findIndex(rule => rule.id === updated.id);
  if (index < 0) return [...rules, updated];
  return rules.map(rule => rule.id === updated.id ? updated : rule);
}

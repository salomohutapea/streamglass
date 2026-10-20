// Subsequence fuzzy matcher for the command palette. Pure and synthetic-data friendly.
export function fuzzyScore(query, text) {
  const q = String(query ?? '').trim().toLowerCase();
  const t = String(text ?? '').toLowerCase();
  if (!q) return { score: 0, indexes: [] };
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const boundary = direct === 0 || /[\s\-_/·:]/.test(t[direct - 1]);
    return { score: 1000 + (boundary ? 200 : 0) - direct - (t.length - q.length) * 0.1, indexes: Array.from({ length: q.length }, (_, i) => direct + i) };
  }
  const indexes = [];
  let score = 0, from = 0, last = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    const boundary = at === 0 || /[\s\-_/·:]/.test(t[at - 1]);
    score += 10 + (at === last + 1 ? 15 : 0) + (boundary ? 12 : 0) - Math.min(at - from, 8) * 0.5;
    indexes.push(at); last = at; from = at + 1;
  }
  return { score, indexes };
}

// Returns commands ordered by match quality; with no query, recent ids first then original order.
export function filterCommands(commands, query, recentIds = []) {
  const recent = new Map(recentIds.map((id, i) => [id, i]));
  if (!String(query ?? '').trim()) {
    return commands.map((command, order) => ({ command, order, indexes: [] }))
      .sort((a, b) => (recent.has(a.command.id) ? recent.get(a.command.id) : 1e6) - (recent.has(b.command.id) ? recent.get(b.command.id) : 1e6) || a.order - b.order);
  }
  const out = [];
  commands.forEach((command, order) => {
    const hit = fuzzyScore(query, command.title);
    const hay = fuzzyScore(query, `${command.title} ${command.keywords ?? ''}`);
    const best = hit ?? (hay ? { score: hay.score - 50, indexes: [] } : null);
    if (!best) return;
    const bonus = recent.has(command.id) ? 5 - recent.get(command.id) * 0.1 : 0;
    out.push({ command, order, indexes: best.indexes, score: best.score + bonus });
  });
  return out.sort((a, b) => b.score - a.score || a.order - b.order);
}

export function pushRecent(recentIds, id, limit = 6) {
  return [id, ...recentIds.filter(item => item !== id)].slice(0, limit);
}

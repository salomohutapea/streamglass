// Deterministic fallback badge for applications without an icon.
export function appBadgeInitials(name) {
  const chars = [...String(name ?? '').trim()].filter(char => /[\p{L}\p{N}]/u.test(char));
  return (chars.slice(0, 2).join('') || '?').toUpperCase();
}

export function appBadgeHue(key) {
  let hash = 2166136261;
  for (const char of String(key ?? '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash % 360;
}

// Fixed saturation/lightness keep white text readable (about 4.5:1 or better) in light and dark themes.
export function appBadge(name, id = name) {
  const hue = appBadgeHue(id || name);
  return { initials: appBadgeInitials(name), background: `hsl(${hue} 48% 36%)`, color: '#fff' };
}

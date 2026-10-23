// Sidebar favorites: applications, devices and domains pinned to the top of the sidebar (local storage).
export const favoritesKey = 'streamglass.sidebar.favorites';
const LIMIT = 50;
export const emptyFavorites = () => ({ apps: [], devices: [], domains: [] });

export function readFavorites(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    const strings = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item && item.length <= 512).slice(0, LIMIT);
    const apps = (Array.isArray(parsed.apps) ? parsed.apps : []).filter(app => app && typeof app.id === 'string' && typeof app.name === 'string' && app.id.length <= 512 && app.name.length <= 200)
      .map(app => ({ id: app.id, name: app.name })).slice(0, LIMIT);
    return { apps, devices: strings(parsed.devices), domains: strings(parsed.domains) };
  } catch { return emptyFavorites(); }
}

export function isFavorite(favorites, kind, id) {
  return kind === 'apps' ? favorites.apps.some(app => app.id === id) : favorites[kind].includes(id);
}

// Adds the item, or removes it when it is already a favorite. `item` is an id, or {id, name} for applications.
export function toggleFavorite(favorites, kind, item) {
  const id = typeof item === 'string' ? item : item.id;
  const list = favorites[kind];
  const present = isFavorite(favorites, kind, id);
  const next = present ? list.filter(entry => (typeof entry === 'string' ? entry : entry.id) !== id) : [...list, kind === 'apps' ? { id, name: item.name } : id].slice(-LIMIT);
  return { ...favorites, [kind]: next };
}

// Case-insensitive match used by the sidebar filter; an empty query matches everything.
export function matchesSidebar(query, ...texts) {
  const needle = query.trim().toLowerCase();
  return !needle || texts.some(text => typeof text === 'string' && text.toLowerCase().includes(needle));
}

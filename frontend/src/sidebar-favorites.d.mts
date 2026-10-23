export type Favorites = { apps: { id: string; name: string }[]; devices: string[]; domains: string[] };
export const favoritesKey: string;
export function emptyFavorites(): Favorites;
export function readFavorites(value: string | null | undefined): Favorites;
export function isFavorite(favorites: Favorites, kind: keyof Favorites, id: string): boolean;
export function toggleFavorite(favorites: Favorites, kind: keyof Favorites, item: string | { id: string; name: string }): Favorites;
export function matchesSidebar(query: string, ...texts: (string | null | undefined)[]): boolean;

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFavorites, isFavorite, matchesSidebar, readFavorites, toggleFavorite } from './sidebar-favorites.mjs';

test('favorites toggle per kind and round-trip through storage', () => {
  let favorites = emptyFavorites();
  favorites = toggleFavorite(favorites, 'apps', { id: 'com.trip.app', name: 'TripApp' });
  favorites = toggleFavorite(favorites, 'devices', '10.0.0.5');
  favorites = toggleFavorite(favorites, 'domains', 'api.example.test');
  assert.equal(isFavorite(favorites, 'apps', 'com.trip.app'), true);
  assert.deepEqual(readFavorites(JSON.stringify(favorites)), favorites);
  favorites = toggleFavorite(favorites, 'domains', 'api.example.test');
  assert.deepEqual(favorites.domains, []);
});

test('stored favorites are validated', () => {
  assert.deepEqual(readFavorites('not json'), emptyFavorites());
  assert.deepEqual(readFavorites(JSON.stringify({ apps: [{ id: 1 }, { id: 'a', name: 'A' }], devices: ['x', 3], domains: 'no' })), { apps: [{ id: 'a', name: 'A' }], devices: ['x'], domains: [] });
});

test('sidebar filter matches any text case-insensitively', () => {
  assert.equal(matchesSidebar('', 'anything'), true);
  assert.equal(matchesSidebar('FPR', 'api.fpr.example'), true);
  assert.equal(matchesSidebar('fpr', 'TripApp', null, '10.0.0.5'), false);
});

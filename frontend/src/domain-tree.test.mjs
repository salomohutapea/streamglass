import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainTree, matchesDomain, isHiddenHost, filterHostNodes, readHiddenHosts, writeHiddenHosts, recordHost, domainFilterLabel } from './domain-tree.mjs';

const r = (id, url, extra = {}) => ({ id, url, ...extra });
const records = [
  r(1, 'https://api.example.com/v1/bookings/1'), r(2, 'https://api.example.com/v1/bookings/2'), r(3, 'https://api.example.com/v1/users'),
  r(4, 'https://api.example.com/v2/ping'), r(5, 'https://cdn.example.test/a.js'),
  r(6, 'api.example.com:443', { kind: 'tunnel', host: 'API.example.com' }), r(7, 'broken url'),
];

test('groups by host then path with counts, sorted by count', () => {
  const tree = buildDomainTree(records);
  assert.equal(tree[0].host, 'api.example.com');
  assert.equal(tree[0].count, 5);
  assert.equal(tree[0].encrypted, 1);
  assert.deepEqual(tree[0].children.map(c => [c.path, c.count]), [['/v1', 3], ['/v2', 1]]);
  assert.deepEqual(tree[0].children[0].children.map(c => [c.path, c.count]), [['/v1/bookings', 2], ['/v1/users', 1]]);
  assert.equal(tree[0].children[0].children[0].children.length, 0);
});

test('tunnels count under their host and hidden hosts are excluded', () => {
  assert.equal(recordHost(records[5]), 'api.example.com');
  const tree = buildDomainTree(records, { hidden: new Set(['api.example.com']) });
  assert.ok(!tree.some(n => n.host === 'api.example.com'));
  assert.equal(isHiddenHost(records[0], new Set(['api.example.com'])), true);
  assert.equal(isHiddenHost(records[4], new Set(['api.example.com'])), false);
});

test('matchesDomain composes host and path prefixes on segment boundaries', () => {
  assert.equal(matchesDomain(records[0], { host: 'api.example.com' }), true);
  assert.equal(matchesDomain(records[0], { host: 'api.example.com', path: '/v1/bookings' }), true);
  assert.equal(matchesDomain(records[0], { host: 'api.example.com', path: '/v1/book' }), false);
  assert.equal(matchesDomain(records[3], { host: 'api.example.com', path: '/v1' }), false);
  assert.equal(matchesDomain(records[4], { host: 'api.example.com' }), false);
  assert.equal(matchesDomain(records[4], null), true);
  assert.equal(domainFilterLabel({ host: 'a.test', path: '/x' }), 'a.test/x');
});

test('caps wide path fan-out and searches hosts', () => {
  const many = Array.from({ length: 100 }, (_, i) => r(i, `https://x.test/p${i}`));
  const [node] = buildDomainTree(many);
  assert.equal(node.children.length, 40);
  assert.equal(node.more, 60);
  assert.deepEqual(filterHostNodes(buildDomainTree(records), 'CDN').map(n => n.host), ['cdn.example.test']);
});

test('hidden hosts persist defensively', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  writeHiddenHosts(new Set(['a.test']), storage);
  assert.deepEqual([...readHiddenHosts(storage)], ['a.test']);
  assert.equal(readHiddenHosts({ getItem() { throw new Error('blocked'); } }).size, 0);
  assert.equal(readHiddenHosts({ getItem: () => '{bad' }).size, 0);
  writeHiddenHosts(new Set(['a']), { setItem() { throw new Error('blocked'); } });
});

export const hiddenHostsKey = 'streamglass.domains.hidden';
const MAX_CHILDREN = 40;
const cache = new WeakMap();

function parse(record) {
  let hit = cache.get(record);
  if (hit && hit.url === record.url && hit.host === record.host) return hit;
  let host = typeof record.host === 'string' ? record.host.trim().toLowerCase() : '';
  let segments = [];
  const url = typeof record.url === 'string' ? record.url : '';
  if (record.kind !== 'tunnel') {
    try {
      const parsed = new URL(url);
      if (!host) host = parsed.hostname.toLowerCase();
      segments = parsed.pathname.split('/').filter(Boolean);
    } catch { /* unparsable URL: host only */ }
  }
  if (!host) host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
  hit = { url: record.url, host: record.host, hostName: host.replace(/:\d+$/, ''), segments };
  cache.set(record, hit);
  return hit;
}

export function recordHost(record) { return parse(record).hostName; }
export function recordSegments(record) { return parse(record).segments; }

export function buildDomainTree(records, { depth = 2, hidden = new Set() } = {}) {
  const hosts = new Map();
  for (const record of records) {
    const { hostName, segments } = parse(record);
    if (!hostName || hidden.has(hostName)) continue;
    let node = hosts.get(hostName);
    if (!node) hosts.set(hostName, node = { host: hostName, path: undefined, label: hostName, count: 0, encrypted: 0, kids: new Map() });
    node.count++;
    if (record.kind === 'tunnel' || record.isEncrypted) node.encrypted++;
    let parent = node;
    for (let i = 0; i < Math.min(depth, segments.length); i++) {
      const path = '/' + segments.slice(0, i + 1).join('/');
      let child = parent.kids.get(path);
      if (!child) parent.kids.set(path, child = { host: hostName, path, label: '/' + segments[i], count: 0, kids: new Map() });
      child.count++;
      parent = child;
    }
  }
  const finish = node => {
    const sorted = [...node.kids.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const children = sorted.slice(0, MAX_CHILDREN).map(finish);
    const out = { host: node.host, path: node.path, label: node.label, count: node.count, children, more: Math.max(0, sorted.length - children.length) };
    if (node.encrypted !== undefined) out.encrypted = node.encrypted;
    return out;
  };
  return [...hosts.values()].map(finish).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

export function matchesDomain(record, filter) {
  if (!filter) return true;
  const { hostName, segments } = parse(record);
  if (hostName !== filter.host) return false;
  if (!filter.path) return true;
  const wanted = filter.path.split('/').filter(Boolean);
  return wanted.length <= segments.length && wanted.every((part, index) => segments[index] === part);
}

export function isHiddenHost(record, hidden) { return hidden.size > 0 && hidden.has(parse(record).hostName); }

export function filterHostNodes(tree, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  return needle ? tree.filter(node => node.host.includes(needle)) : tree;
}

export function domainFilterLabel(filter) { return filter ? filter.host + (filter.path ?? '') : ''; }

export function readHiddenHosts(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(hiddenHostsKey) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string' && item && item.length < 256).slice(0, 500) : []);
  } catch { return new Set(); }
}

export function writeHiddenHosts(hosts, storage = globalThis.localStorage) {
  try { storage.setItem(hiddenHostsKey, JSON.stringify([...hosts].slice(0, 500))); } catch { /* storage unavailable */ }
}

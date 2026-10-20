import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { registerTools } from '../electron/mcp-tools.mjs';

async function fixture(t) {
  const state = { settings: { capturePaused: false }, rules: [], rulesRevision: 0, trafficToolsRevision: 0, folders: [], records: [{ id: 'capture', url: 'https://example.test', isSSE: true }], pending: [] };
  const record = { id: 'capture', state: 'streaming', events: [], eventCount: 0, request: { body: 'x'.repeat(100000) } };
  const requests = [];
  const controls = { conflictRulePut: false, conflictTrafficPut: false };
  let traffic = { mapLocalRules: [], network: { enabled: false, delayMs: 0, downloadKbps: 0, uploadKbps: 0, hostPattern: '*', deviceId: '' } };
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer management-secret');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/traffic-tools') {
      if (req.method === 'PUT') {
        if (controls.conflictTrafficPut) { controls.conflictTrafficPut = false; state.trafficToolsRevision++; }
        if (body.revision !== state.trafficToolsRevision) { res.statusCode = 409; return res.end(JSON.stringify({ error: { code: 'revision_conflict', message: 'Reload traffic tools and retry' } })); }
        traffic = body.config; state.trafficToolsRevision++;
        return res.end(JSON.stringify({ config: traffic, revision: state.trafficToolsRevision }));
      }
      return res.end(JSON.stringify({ config: traffic, revision: state.trafficToolsRevision }));
    }
    if (req.url === '/api/records/capture/pin') return res.end(JSON.stringify({ pinned: body.pinned }));
    if (req.url === '/api/state') return res.end(JSON.stringify(state));
    if (req.url === '/api/rules') {
      await new Promise(r => setTimeout(r, 10));
      if (controls.conflictRulePut) { controls.conflictRulePut = false; state.rulesRevision++; }
      if (body.revision !== state.rulesRevision) { res.statusCode = 409; return res.end(JSON.stringify({ error: { code: 'revision_conflict', message: 'Reload rules and retry' } })); }
      state.rules = body.rules; state.rulesRevision++;
      return res.end(JSON.stringify({ rules: state.rules, revision: state.rulesRevision }));
    }
    if (req.url === '/api/records/capture') { if (record.delayMs) await new Promise(resolve => setTimeout(resolve, record.delayMs)); return res.end(JSON.stringify(record)); }
    if (req.url.startsWith('/api/export/')) return res.end(JSON.stringify(record.request));
    if (req.method === 'DELETE' && req.url.startsWith('/api/records')) return res.end(JSON.stringify({ deleted: 1 }));
    if (req.url.startsWith('/api/pending/')) return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/api/settings') { Object.assign(state.settings, body); return res.end(JSON.stringify(state.settings)); }
    res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Invalid management-secret' } }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  const bootstrap = { baseUrl: `http://127.0.0.1:${http.address().port}`, token: 'management-secret' };
  function client() {
    const tools = new Map();
    registerTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } }, bootstrap);
    return { tools, async call(name, args = {}, extra = {}) {
      const tool = tools.get(name);
      const result = await tool.handler(z.object(tool.config.inputSchema).parse(args), { signal: new AbortController().signal, ...extra });
      return { ...result, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
    } };
  }
  return { state, record, requests, client, bootstrap, controls };
}

test('tools bind only to authenticated loopback and mark mutations', async t => {
  assert.throws(() => registerTools({}, { baseUrl: 'https://remote.test', token: 'secret' }), /loopback/);
  const f = await fixture(t), c = f.client();
  assert.equal((await c.call('get_status')).value.captures, 1);
  assert.equal(c.tools.get('delete_folder').config.annotations.destructiveHint, true);
  assert.equal(c.tools.get('get_capture').config.annotations.readOnlyHint, true);
  assert.equal(c.tools.get('upsert_rule').config.annotations.destructiveHint, true);
  assert.equal(c.tools.get('upsert_map_local_rule').config.annotations.destructiveHint, true);
  assert.equal(c.tools.get('set_network_profile').config.annotations.destructiveHint, true);
  const error = await c.tools.get('get_capture').handler({ recordId: 'unknown', section: 'metadata' }, {});
  assert.equal(error.isError, true); assert.ok(!error.content[0].text.includes('management-secret'));
});

test('capture and export pages are bounded with explicit continuation', async t => {
  const f = await fixture(t), c = f.client();
  const first = (await c.call('get_capture', { recordId: 'capture', section: 'request', maxChars: 256 })).value;
  assert.equal(first.text.length, 256); assert.equal(first.nextOffset, 256); assert.equal(first.truncated, true);
  const second = (await c.call('get_capture', { recordId: 'capture', section: 'request', maxChars: 256, offset: 256 })).value;
  assert.equal(second.offset, 256);
  const exported = (await c.call('export_capture', { recordId: 'capture', format: 'request', maxChars: 256 })).value;
  assert.equal(exported.text.length, 256); assert.ok(exported.totalChars > 100000);
  f.record.application = { name: 'Synthetic App', icon: 'data:image/png;base64,' + 'a'.repeat(100000) };
  f.record.annotation = { note: 'n'.repeat(1000) };
  const metadata = (await c.call('get_capture', { recordId: 'capture', maxChars: 256 })).value;
  assert.equal(metadata.section, 'metadata'); assert.equal(metadata.text.length, 256);
  let text = metadata.text, next = metadata.nextOffset;
  while (next !== null) {
    const part = (await c.call('get_capture', { recordId: 'capture', offset: next, maxChars: 256 })).value;
    text += part.text; next = part.nextOffset;
  }
  assert.equal(JSON.parse(text).annotation.note.length, 1000);
  assert.equal(JSON.parse(text).application.icon, undefined);
  await assert.rejects(c.call('get_capture', { recordId: 'capture', maxChars: 32769 }));
});

test('capture list pages advance by output budget and omit application icon assets', async t => {
  const f = await fixture(t), c = f.client();
  f.state.records = Array.from({ length: 10 }, (_, index) => ({ id: `record-${index}`, application: { name: 'Synthetic App', icon: 'x'.repeat(100000) }, annotation: { note: 'n'.repeat(8000) } }));
  const first = (await c.call('list_captures', { limit: 10 })).value;
  assert.ok(first.items.length > 0 && first.items.length < 10);
  assert.equal(first.nextOffset, first.items.length);
  assert.equal(first.items[0].application.icon, undefined);
  const second = (await c.call('list_captures', { offset: first.nextOffset, limit: 10 })).value;
  assert.equal(second.items[0].id, `record-${first.nextOffset}`);
});

test('status stays compact while full settings and Map Local metadata remain pageable', async t => {
  const f = await fixture(t), c = f.client();
  f.state.settings.tlsDomains = Array.from({ length: 200 }, (_, index) => `host-${index}.example.test`);
  const status = (await c.call('get_status')).value;
  assert.equal(status.settings.tlsDomainsCount, 200);
  assert.equal(status.settings.tlsDomains, undefined);
  const settings = (await c.call('get_settings', { maxChars: 256 })).value;
  assert.equal(settings.text.length, 256);
  assert.ok(settings.nextOffset > 0);
  await c.call('upsert_map_local_rule', { rule: { id: 'one', name: 'One', enabled: true, pattern: '*', method: '*', statusCode: 200, headers: [['X-Test', 'value']], bodyBase64: 'eA==' } });
  const tools = (await c.call('get_traffic_tools', { limit: 1 })).value;
  assert.equal(tools.total, 1);
  assert.equal(tools.mapLocalRules[0].bodyBase64, undefined);
  assert.equal(tools.mapLocalRules[0].bodyBase64Chars, 4);
  assert.equal(tools.mapLocalRules[0].headers, undefined);
  assert.equal(tools.mapLocalRules[0].headersCount, 1);
  const rule = (await c.call('get_map_local_rule', { ruleId: 'one' })).value;
  assert.deepEqual(JSON.parse(rule.text).headers, [['X-Test', 'value']]);
  assert.equal(JSON.parse(rule.text).bodyBase64, undefined);
});

test('rule updates read latest and serialize across sessions', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  const rule = id => ({ id, pattern: '*', stages: ['request'], breakpoint: false, script: 'function onRequest() {}' });
  await Promise.all([a.call('upsert_rule', { rule: rule('a') }), b.call('upsert_rule', { rule: rule('b') })]);
  assert.deepEqual(f.state.rules.map(r => r.id), ['a', 'b']);
  await a.call('delete_rule', { ruleId: 'a' });
  assert.deepEqual(f.state.rules.map(r => r.id), ['b']);
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 3);
  assert.deepEqual(f.requests.filter(r => r.url === '/api/rules').map(r => r.body.revision), [0, 1, 2]);
});

test('MCP rule changes report a concurrent edit instead of overwriting it', async t => {
  const f = await fixture(t), c = f.client();
  f.controls.conflictRulePut = true;
  const result = await c.call('upsert_rule', { rule: { id: 'new', pattern: '*', stages: ['request'] } });
  assert.equal(result.isError, true);
  assert.match(result.value, /HTTP 409: revision_conflict/);
  assert.deepEqual(f.state.rules, []);
});

test('SSE watcher sends context and data before capture completes, resumes once, and reports retention', async t => {
  const f = await fixture(t), c = f.client(), messages = [];
  const extra = { _meta: { progressToken: 'watch' }, async sendNotification(n) {
    assert.equal(n.method, 'notifications/progress');
    messages.push(JSON.parse(n.params.message));
    if (messages.at(-1).type === 'context') {
      f.record.events.push({ sequence: 1, event: 'context', data: 'first' }); f.record.eventCount = 1;
    }
  } };
  const watching = c.call('watch_sse_events', { recordId: 'capture', durationMs: 1000, limit: 2 }, extra);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(messages.map(m => m.type), ['context', 'event']);
  assert.equal(f.record.state, 'streaming');
  f.record.events.push({ sequence: 2, event: 'data', data: 'second' }); f.record.eventCount = 2;
  const done = (await watching).value;
  assert.equal(done.nextSequence, 2); assert.equal(done.eventsSent, 2);
  f.record.events.push({ sequence: 3, event: 'data', data: 'third' }); f.record.eventCount = 4;
  f.record.endedAt = Date.now();
  const resumed = [];
  const result = await c.call('watch_sse_events', { recordId: 'capture', afterSequence: 2, durationMs: 100 }, {
    async sendNotification(n) { assert.equal(n.method, 'notifications/message'); resumed.push(n.params.data); }
  });
  assert.deepEqual(resumed.filter(m => m.type === 'event').map(m => m.sequence), [3]);
  assert.equal(result.value.nextSequence, 3); assert.equal(result.value.retentionGap, true);
});

test('SSE watch cancellation stops polling and large events are explicitly truncated', async t => {
  const f = await fixture(t), c = f.client(), controller = new AbortController(), messages = [];
  f.record.events = [{ sequence: 1, data: 'x'.repeat(10000) }]; f.record.eventCount = 1;
  const result = await c.call('watch_sse_events', { recordId: 'capture', durationMs: 30000, maxChars: 256 }, {
    signal: controller.signal, async sendNotification(n) { messages.push(n.params.data); if (n.params.data.type === 'event') controller.abort(); }
  });
  assert.equal(result.isError, true);
  assert.equal(messages[1].truncated, true); assert.equal(messages[1].text.length, 256);
  const count = f.requests.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.requests.length, count);
});


test('mutations forward only validated settings, scoped deletion and pending decisions', async t => {
  const f = await fixture(t), c = f.client();
  await c.call('update_settings', { capturePaused: true, proxyEnabled: false, tlsDomains: ['*.example.test'] });
  assert.deepEqual(f.requests.at(-1).body, { capturePaused: true, proxyEnabled: false, tlsDomains: ['*.example.test'] });
  assert.equal((await c.call('clear_captures', { scope: 'device' })).isError, true);
  await c.call('clear_captures', { scope: 'device', device: 'iPhone:4321' });
  assert.equal(f.requests.at(-1).url, '/api/records?device=iPhone%3A4321');
  await c.call('resolve_pending', { gateToken: 'gate', action: 'continue', value: { headers: [['x-test', 'ok']] } });
  assert.deepEqual(f.requests.at(-1).body, { action: 'continue', value: { headers: [['x-test', 'ok']] } });
  const count = f.requests.length;
  const oversized = await c.call('resolve_pending', { gateToken: 'gate', action: 'continue', value: { body: 'x'.repeat(200000) } });
  assert.equal(oversized.isError, true); assert.equal(f.requests.length, count);
});


test('SSE watch duration bounds a stalled management request', async t => {
  const f = await fixture(t), c = f.client(); f.record.delayMs = 1000;
  const started = Date.now();
  const result = await c.call('watch_sse_events', { recordId: 'capture', durationMs: 100 }, { async sendNotification() {} });
  assert.equal(result.isError, undefined); assert.equal(result.value.nextSequence, 0);
  assert.ok(Date.now() - started < 750);
});

 test('traffic tools preserve bodies during network changes, omit bodies in summaries, validate order and pin through API', async t => {
  const f = await fixture(t), c = f.client();
  const rule = { id: 'local', name: 'Local', enabled: true, pattern: '*', method: '*', statusCode: 200, headers: [['X-Test', 'one'], ['X-Test', 'two']], bodyBase64: 'aGVsbG8=' };
  assert.equal((await c.call('upsert_map_local_rule', { rule })).value.saved, true);
  const summary = (await c.call('get_traffic_tools')).value;
  assert.equal(summary.mapLocalRules[0].bodyBase64, undefined);
  assert.equal(summary.mapLocalRules[0].bodyBase64Chars, 8);
  await c.call('set_network_profile', { enabled: true, delayMs: 100, downloadKbps: 0, uploadKbps: 0, hostPattern: '*', deviceId: '' });
  assert.equal(f.requests.at(-1).body.config.mapLocalRules[0].bodyBase64, rule.bodyBase64);
  assert.deepEqual(f.requests.filter(r => r.url === '/api/traffic-tools' && r.method === 'PUT').map(r => r.body.revision), [0, 1]);
  assert.equal((await c.call('reorder_map_local_rules', { ruleIds: ['missing'] })).isError, true);
  assert.equal((await c.call('pin_capture', { recordId: 'capture', pinned: true })).value.pinned, true);
});

test('MCP traffic tool changes report a concurrent desktop edit without overwriting it', async t => {
  const f = await fixture(t), c = f.client();
  f.controls.conflictTrafficPut = true;
  const result = await c.call('set_network_profile', { enabled: true, delayMs: 100, downloadKbps: 0, uploadKbps: 0, hostPattern: '*', deviceId: '' });
  assert.equal(result.isError, true);
  assert.match(result.value, /HTTP 409: revision_conflict/);
  assert.equal((await c.call('get_traffic_tools')).value.network.enabled, false);
});

test('Map Remote, Rewrite and Block tools share the revisioned traffic configuration and group toggles', async t => {
  const f = await fixture(t), c = f.client();
  const common = (id, group) => ({ id, name: id, enabled: true, pattern: 'https://api.example.com/*', method: '*', ...(group ? { group } : {}) });
  const remote = { ...common('remote', 'Staging'), scheme: 'https', host: 'staging.example.com', port: 0, pathFrom: '/v1', pathTo: '/v2', keepHost: false,
    headerOps: [{ op: 'set', name: 'Authorization', value: 'Bearer staging-token' }, { op: 'remove', name: 'Cookie' }] };
  const rewrite = { ...common('rewrite', 'Staging'), phase: 'response', headerOps: [], statusCode: 503, bodyFind: 'a', bodyReplace: 'b' };
  const block = { ...common('block'), action: 'respond', statusCode: 451, body: 'Blocked' };
  assert.equal((await c.call('upsert_map_remote_rule', { rule: remote })).value.saved, true);
  assert.equal((await c.call('upsert_rewrite_rule', { rule: rewrite })).value.saved, true);
  assert.equal((await c.call('upsert_block_rule', { rule: block })).value.saved, true);
  assert.equal(c.tools.get('upsert_block_rule').config.annotations.destructiveHint, true);
  assert.equal(c.tools.get('list_block_rules').config.annotations.readOnlyHint, true);
  const listed = (await c.call('list_map_remote_rules')).value;
  assert.equal(listed.total, 1);
  assert.equal(listed.rules[0].headerOps, undefined);
  assert.equal(listed.rules[0].headerOpsCount, 2);
  assert.equal(JSON.parse((await c.call('get_map_remote_rule', { ruleId: 'remote' })).value.text).headerOps[0].value, 'Bearer staging-token');
  assert.equal((await c.call('list_rewrite_rules', { group: 'Other' })).value.total, 0);
  const toggled = (await c.call('set_traffic_rule_group_enabled', { group: 'Staging', enabled: false })).value;
  assert.equal(toggled.changed, 2);
  const config = f.requests.at(-1).body.config;
  assert.deepEqual([config.mapRemoteRules[0].enabled, config.rewriteRules[0].enabled, config.blockRules[0].enabled], [false, false, true]);
  assert.equal((await c.call('set_block_rule_enabled', { ruleId: 'block', enabled: false })).value.enabled, false);
  assert.equal((await c.call('reorder_block_rules', { ruleIds: ['missing'] })).isError, true);
  assert.equal((await c.call('delete_rewrite_rule', { ruleId: 'missing' })).isError, true);
  assert.equal((await c.call('delete_rewrite_rule', { ruleId: 'rewrite' })).value.deleted, 'rewrite');
  assert.equal((await c.call('list_rewrite_rules')).value.total, 0);
});

test('timing tools expose server time, breakdown, sizes and SSE gaps, and filter slow captures', async t => {
  const f = await fixture(t), c = f.client();
  f.state.records = [{ id: 'fast', durationMs: 40, serverMs: 20 }, { id: 'slow', durationMs: 900, serverMs: 850 }, { id: 'unknown' }];
  const slow = (await c.call('list_captures', { minServerMs: 100, sortBy: 'serverMs' })).value;
  assert.deepEqual(slow.items.map(item => item.id), ['slow']);
  assert.deepEqual((await c.call('list_captures', { sortBy: 'durationMs' })).value.items.map(item => item.id), ['slow', 'fast', 'unknown']);
  Object.assign(f.record, { method: 'GET', url: 'https://api.example.test/feed', statusCode: 200, state: 'complete', isSSE: true, durationMs: 1200, requestSize: 0, responseSize: 512,
    timings: { requestStart: 1000, requestSent: 1010, responseHeaders: 1210, responseEnd: 2200, connectMs: 4, tlsMs: 6, requestMs: 0, serverMs: 200, downloadMs: 990, pausedMs: null },
    sseDiagnostics: { gapStats: { count: 3, min: 10, avg: 300, p95: 800, max: 800 } },
    events: [{ sequence: 1, event: 'a', gapMs: 10 }, { sequence: 2, event: 'b', gapMs: 800 }, { sequence: 3, event: 'c', gapMs: 90 }] });
  const timing = (await c.call('get_capture_timing', { recordId: 'capture', slowestGaps: 2 })).value;
  assert.equal(timing.serverMs, 200);
  assert.deepEqual(timing.breakdown, { connectMs: 4, tlsMs: 6, requestMs: 0, serverMs: 200, downloadMs: 990, pausedMs: null });
  assert.equal(timing.timestamps.requestSent, 1010);
  assert.equal(timing.sizes.responseBytes, 512);
  assert.equal(timing.sse.gapStats.p95, 800);
  assert.deepEqual(timing.sse.slowestGaps.map(gap => gap.sequence), [2, 3]);
  assert.equal(JSON.stringify(timing).includes('"body"'), false);
});

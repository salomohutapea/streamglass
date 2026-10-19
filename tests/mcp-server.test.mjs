import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema, ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startMcpServer } from '../electron/mcp-server.mjs';

const authToken = 'test-mcp-token-distinct-from-management-token';
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const headers = { Authorization: `Bearer ${authToken}` };
async function fixture(t) {
  let reads = 0;
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer engine-only-secret');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state') res.end(JSON.stringify({ settings: { capturePaused: false }, records: [{ id: 'capture-1' }], pending: [], rules: [], folders: [] }));
    else if (req.url === '/api/records/capture-1') {
      reads++;
      res.end(JSON.stringify({ id: 'capture-1', state: 'streaming', eventCount: reads, events: Array.from({ length: Math.min(reads, 2) }, (_, i) => ({ sequence: i + 1, event: 'message', data: `event-${i + 1}` })) }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const bootstrap = { baseUrl: `http://127.0.0.1:${backend.address().port}`, token: 'engine-only-secret' };
  const server = await startMcpServer({ port: 0, authToken, bootstrap });
  t.after(async () => { await server.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  return { server, bootstrap };
}
async function until(check) {
  for (let i = 0; i < 50; i++) { if (check()) return; await delay(10); }
  assert.ok(check(), 'condition did not become true');
}

for (const protocol of ['sse', 'streamable']) {
  test(`${protocol}: official SDK initialize, tools, incremental progress, and cleanup`, async t => {
    const { server } = await fixture(t);
    const transport = protocol === 'sse'
      ? new SSEClientTransport(new URL(server.sseUrl), { requestInit: { headers } })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
    const client = new Client({ name: 'integration-test', version: '1.0' });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'streamglass');
    assert.equal(client.getServerVersion().version, packageVersion);
    assert.equal(server.sessionCount, 1);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'get_status'));
    const result = await client.callTool({ name: 'get_status', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).captures, 1);
    assert.ok(!JSON.stringify(result).includes('engine-only-secret'));
    const progress = [];
    let finished = false;
    client.setNotificationHandler(ProgressNotificationSchema, event => { assert.equal(finished, false); progress.push(event.params); });
    const watch = client.callTool({ name: 'watch_sse_events', arguments: { recordId: 'capture-1', durationMs: 1000, limit: 2 }, _meta: { progressToken: 'capture-watch' } });
    await until(() => progress.length > 0);
    const watched = await watch;
    finished = true;
    assert.ok(!watched.isError, JSON.stringify(watched));
    assert.ok(progress.length >= 3, 'context and both events arrive before the result');
    assert.ok(progress.some(event => event.message?.includes('event-1')));
    assert.ok(progress.some(event => event.message?.includes('event-2')));
    assert.deepEqual(progress.map(event => JSON.parse(event.message).type), ['context', 'event', 'event']);
    assert.deepEqual(progress.slice(1).map(event => JSON.parse(event.message).sequence), [1, 2]);
    const logs = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, event => { logs.push(event.params); });
    await client.callTool({ name: 'watch_sse_events', arguments: { recordId: 'capture-1', afterSequence: 1, durationMs: 100, limit: 1 } });
    assert.ok(logs.length >= 2, 'clients without progress tokens receive logging context and event');
    assert.deepEqual(logs.filter(log => log.data.type === 'event').map(log => log.data.sequence), [2]);
    if (protocol === 'streamable') await transport.terminateSession();
    await client.close();
    await until(() => server.sessionCount === 0);
  });
}

test('every endpoint requires the dedicated token, exact local Host, and no browser Origin', async t => {
  const { server } = await fixture(t);
  for (const path of ['/sse', '/messages', '/mcp', '/unknown']) {
    const url = new URL(path, server.url);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer engine-only-secret' } })).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'http://127.0.0.1' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'null' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = http.get(url, { headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(badHost, 403);
  }
  assert.equal(server.sessionCount, 0);
  assert.equal((await fetch(server.url, { headers: { ...headers, 'Mcp-Session-Id': 'missing' } })).status, 404);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});

test('sessions are bounded, legacy disconnect cleans up, shutdown closes streams, port conflict rejects', async t => {
  const { server, bootstrap } = await fixture(t);
  await assert.rejects(startMcpServer({ port: server.port, authToken, bootstrap }), { code: 'EADDRINUSE' });
  const controllers = [];
  t.after(() => controllers.forEach(controller => controller.abort()));
  for (let i = 0; i < 16; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(server.sseUrl, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
  }
  assert.equal(server.sessionCount, 16);
  assert.equal((await fetch(server.sseUrl, { headers })).status, 503);
  controllers.pop().abort();
  await until(() => server.sessionCount === 15);
  await server.close();
  assert.equal(server.sessionCount, 0);
  await server.close();
});

test('pending RPCs are bounded and shutdown cancels active watches', async t => {
  const { server } = await fixture(t);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
  const client = new Client({ name: 'bounded-client', version: '1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const calls = Array.from({ length: 9 }, () => client.callTool({ name: 'watch_sse_events', arguments: { recordId: 'capture-1', afterSequence: 100, durationMs: 30000 } }).then(value => ({ value }), error => ({ error })));
  const first = await Promise.race(calls);
  assert.match(first.error?.message ?? '', /Too many pending requests/);
  await server.close();
  await client.close();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes.filter(result => result.error).length, 9);
  assert.equal(server.sessionCount, 0);
});

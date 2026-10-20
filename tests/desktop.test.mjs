import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { _electron as electron } from 'playwright';
import { readMonacoText, setMonacoText } from './monaco-helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let sidebarNudge = 0;
async function openSidebar(page) { for (let attempt = 0; attempt < 6; attempt++) { await page.mouse.move(600, 400); await page.locator('.sidebar').hover({ position: { x: 10 + (sidebarNudge++ % 7), y: 150 + (attempt % 3) * 20 } }); await page.waitForTimeout(60); if (await page.locator('.sidebar:hover').count()) return; } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function eventually(check, message) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

test('desktop boots, edits rules and preserves binary traffic through breakpoint edits', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-desktop-'));
  const reservation = net.createServer();
  const proxyPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  execFileSync(path.join(root, '.venv/bin/python'), ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2]),'tlsDomains':['one.example','two.example']})))
c.commit()`, path.join(directory, 'captures.sqlite3'), String(proxyPort)]);
  const payload = Buffer.from([0, 255, 128, 10, 13, 1]);
  let received;
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/application-owner') {
      setTimeout(() => res.end('application-owner'), 6000);
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: context\ndata: {"requestId":9007199254740993123}\n\nevent: data\ndata: {"flights":[1,2],"untouched":9007199254740993123,"exponent":1.00e+40}\n\n');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { body: Buffer.concat(chunks), headers: req.rawHeaders };
    res.writeHead(201, ['Content-Type', 'application/octet-stream', 'Content-Length', String(payload.length), 'X-Duplicate', 'first', 'X-Duplicate', 'second']);
    res.end(payload);
  });
  const fixturePort = await listen(fixture);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'fixture.key'), '-out', path.join(directory, 'fixture.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const httpsFixture = tls.createServer({ key: await readFile(path.join(directory, 'fixture.key')), cert: await readFile(path.join(directory, 'fixture.crt')) }, socket => {
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nprivate-body!'));
  });
  const httpsPort = await listen(httpsFixture);
  let app;
  try {
    const env = { ...process.env, STREAMGLASS_MCP_PORT: '0', STREAMGLASS_KEEP_CAPTURES: '1', STREAMGLASS_BUILT_UI: '1', STREAMGLASS_DATA_DIR: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.STREAMGLASS_TEST_APP;
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(directory, 'chromium')}`], env, timeout: 30000 });
    const page = await app.firstWindow();
    await page.getByRole('dialog',{name:'Welcome tour'}).getByRole('button',{name:'Skip tour'}).click();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const brandLogo = page.getByRole('img', { name: 'Streamglass logo', exact: true });
    await brandLogo.waitFor();
    await eventually(() => brandLogo.evaluate(image => image.complete && image.naturalWidth > 0), 'Brand logo did not render');
    const bootstrap = await page.evaluate(() => window.streamglass.getBootstrap());
    const mcp = await page.evaluate(() => window.streamglass.getMcpConnection());
    assert.equal(mcp.running, true, mcp.error);
    assert.notEqual(mcp.token, bootstrap.token);
    const agent = new Client({ name: 'desktop-smoke', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } });
    try {
      await agent.connect(transport);
      assert.ok((await agent.listTools()).tools.some(tool => tool.name === 'watch_sse_events'));
      assert.notEqual((await agent.callTool({ name: 'get_status', arguments: {} })).isError, true);
    } finally { await transport.terminateSession(); await agent.close(); }
    assert.match(bootstrap.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    async function api(route, method = 'GET', body) {
      const response = await fetch(bootstrap.baseUrl + route, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    }
    await eventually(async () => (await api('/api/state')).settings.proxyRunning, 'Proxy did not start');
    if (process.platform === 'darwin') {
      const expectedPid = await app.evaluate(() => process.pid);
      await app.evaluate(async (_electron, { proxyPort, fixturePort }) => {
        const http = process.getBuiltinModule('node:http');
        await new Promise((resolve, reject) => {
          const request = http.get({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${fixturePort}/application-owner` }, response => {
            response.resume(); response.on('end', resolve);
          });
          request.on('error', reject);
        });
      }, { proxyPort, fixturePort });
      const attributed = await eventually(async () => (await api('/api/state')).records.find(record => record.url?.endsWith('/application-owner') && record.application), 'Local Electron application attribution did not arrive').catch(async error => { const r = (await api('/api/state')).records.find(r => r.url?.endsWith('/application-owner')); throw new Error(error.message + JSON.stringify({clientIsLocal:r?.clientIsLocal,application:r?.application,device:r?.device,state:r?.state})); });
      assert.equal(attributed.clientIsLocal, true);
      assert.equal(attributed.application.pid, expectedPid);
      assert.equal(attributed.application.kind, 'application');
      assert.match(attributed.application.icon, /^data:image\/png;base64,/);
    }
    await openSidebar(page);
    await page.getByRole('button', { name: '2 domains', exact: false }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const domains = page.locator('[data-domain-row]');
    assert.equal((await page.evaluate(() => window.streamglass.getMcpConnection())).token, mcp.token);
    assert.deepEqual(await domains.evaluateAll(inputs => inputs.map(input => input.value)), ['one.example', 'two.example']);
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual((await api('/api/state')).settings.tlsDomains, ['one.example', 'two.example']);

    let editorOpened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'JavaScript hooks', exact: true }).click();
    let editor = await editorOpened;
    await editor.getByRole('button', { name: 'Add rule', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Binary hook');
    await editor.getByRole('textbox', { name: 'URL wildcard', exact: false }).fill(`http://127.0.0.1:${fixturePort}/*`);
    await editor.getByRole('textbox', { name: 'JavaScript', exact: true }).fill('function onRequest(context, url, request) { request.headers.push(["X-Hook", "executed"]); return request; }');
    await editor.getByRole('button', { name: 'Save rule', exact: true }).click();
    await editor.getByRole('button', { name: 'Add rule', exact: true }).waitFor();
    await editor.close();
    editorOpened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Breakpoint rules', exact: true }).click();
    editor = await editorOpened;
    await editor.getByRole('button', { name: 'Add rule', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Pause binary');
    await editor.getByRole('textbox', { name: 'URL wildcard', exact: false }).fill(`http://127.0.0.1:${fixturePort}/*`);
    await editor.getByRole('button', { name: 'Save rule', exact: true }).click();
    await editor.getByRole('button', { name: 'Add rule', exact: true }).waitFor();
    await editor.close();
    const rules = (await api('/api/state')).rules;
    assert.equal(rules.length, 2);
    assert.equal(rules.find(rule => rule.name === 'Binary hook').breakpoint, false);

    editorOpened = app.waitForEvent('window');
    const result = new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: `http://127.0.0.1:${fixturePort}/binary`, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.rawHeaders }));
      });
      request.setTimeout(25000, () => request.destroy(new Error('Proxied request timed out')));
      request.on('error', reject);
      request.end(payload);
    });
    // Observe rejection immediately while the UI resolves the pending request.
    result.catch(() => {});
    const gate = await eventually(async () => (await api('/api/state')).pending[0], 'No breakpoint appeared');
    editor = await editorOpened;
    await editor.locator('.headers-disclosure summary').waitFor();
    assert.equal(await editor.locator('.headers-disclosure').evaluate(element => element.open), false);
    assert.equal(await (await app.browserWindow(editor)).evaluate(window => window.isFullScreenable()), false);
    assert.equal(await (await app.browserWindow(editor)).evaluate(window => window.isFullScreen()), false);
    await editor.close();
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(app.windows().filter(window => window.url().includes('editor=paused')).length, 0, 'Closing a popup must not reopen the same gate');
    await openSidebar(page);
    await page.locator('.sidebar .pending-label').click();
    assert.equal(await page.locator('.inspector textarea').count(), 0);
    editorOpened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Open breakpoint editor', exact: true }).click();
    editor = await editorOpened;
    const headers = editor.getByRole('textbox', { name: 'Headers (JSON pairs)' });
    await editor.locator('.headers-disclosure summary').click();
    await headers.waitFor();
    const headerPairs = JSON.parse(await headers.inputValue());
    headerPairs.push(['X-Edited', 'one'], ['X-Edited', 'two']);
    await headers.fill(JSON.stringify(headerPairs));
    await editor.getByRole('button', { name: 'Continue', exact: true }).focus();
    // Continuing the last paused item closes the window, possibly before the key-up arrives.
    await editor.keyboard.press('Meta+Enter').catch(error => { if (!editor.isClosed()) throw error; });
    // The single Breakpoints window closes once every paused request is handled.
    await eventually(() => editor.isClosed(), 'The Breakpoints window must close once its list is empty');
    editorOpened = app.waitForEvent('window');
    const response = await result;
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, payload);
    assert.deepEqual(received.body, payload);
    assert.ok(received.headers.includes('executed'), 'JavaScript hook must execute');
    assert.deepEqual(received.headers.filter((_, i) => i % 2 && received.headers[i - 1].toLowerCase() === 'x-edited'), ['one', 'two']);
    assert.deepEqual(response.headers.filter((_, i) => i % 2 && response.headers[i - 1].toLowerCase() === 'x-duplicate'), ['first', 'second']);
    const record = await eventually(async () => { const record = await api(`/api/records/${gate.recordId}`); return record.state === 'complete' && record; }, 'Capture did not finish');
    assert.equal(record.request.bodyBase64, payload.toString('base64'));
    assert.equal(record.response.bodyBase64, payload.toString('base64'));
    await api('/api/rules', 'PUT', { revision: (await api('/api/state')).rulesRevision, rules: [{ id: 'sse-auto', name: 'SSE auto editor', enabled: true, method: 'POST', pattern: `http://127.0.0.1:${fixturePort}/events`, stages: ['response', 'event'], breakpoint: true }] });
    const sseResult = new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: `http://127.0.0.1:${fixturePort}/events`, headers: { 'X-Request-Context': 'visible-request', 'Content-Type': 'application/json' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      request.setTimeout(20000, () => request.destroy(new Error('SSE editor timed out')));
      request.on('error', reject); request.end('{"query":"request-body-context"}');
    });
    sseResult.catch(() => {});
    editor = await editorOpened;
    await editor.getByRole('spinbutton', { name: 'Status code', exact: true }).waitFor();
    const requestContext = editor.getByRole('region', { name: 'Request context', exact: true });
    await requestContext.getByText('request-body-context', { exact: false }).waitFor();
    assert.equal(await requestContext.locator('.headers-disclosure').evaluate(element => element.open), false);
    assert.equal(await editor.locator('.editor-edit-pane .headers-disclosure').evaluate(element => element.open), false);
    assert.equal(await requestContext.evaluate(element => element.querySelector('.json-viewer').compareDocumentPosition(element.querySelector('.headers-disclosure')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
    await requestContext.locator('.headers-disclosure summary').click();
    await requestContext.getByText('visible-request', { exact: true }).waitFor();
    await requestContext.getByText('request-body-context', { exact: false }).waitFor();
    assert.equal(await requestContext.locator('input:not(.monaco-editor *), textarea:not(.monaco-editor *)').count(), 0, 'Request context must remain read only');
    const requestBounds = await requestContext.boundingBox();
    const editBounds = await editor.getByRole('region', { name: 'Paused traffic editor', exact: true }).boundingBox();
    assert.ok(requestBounds.x + requestBounds.width <= editBounds.x, 'Request and editable response must appear side by side');
    const liveMcp = await page.evaluate(() => window.streamglass.getMcpConnection());
    const watcher = new Client({ name: 'live-sse-proof', version: '1.0.0' });
    const watchTransport = new StreamableHTTPClientTransport(new URL(liveMcp.url), { requestInit: { headers: { Authorization: `Bearer ${liveMcp.token}` } } });
    await watcher.connect(watchTransport);
    const sseGate = (await api('/api/state')).pending[0];
    const notifications = [];
    let watchFinished = false;
    const watched = watcher.callTool({ name: 'watch_sse_events', arguments: { recordId: sseGate.recordId, durationMs: 15000 } }, undefined, {
      onprogress: progress => { if (progress.message) notifications.push(JSON.parse(progress.message)); },
    }).finally(() => { watchFinished = true; });
    watched.catch(() => {});
    await editor.getByRole('button', { name: 'Continue', exact: true }).click();
    const eventData = editor.getByRole('textbox', { name: 'Event data', exact: true });
    await eventData.waitFor();
    const initialEventData = await readMonacoText(app, eventData);
    assert.match(initialEventData, /\n/);
    assert.match(initialEventData, /9007199254740993123/);
    await editor.getByRole('button', { name: 'Continue', exact: true }).click();
    const bodyEditor = editor.locator('.json-body-editor');
    await bodyEditor.getByText('\"flights\"', { exact: true }).waitFor();
    assert.equal(app.windows().filter(window => window.url().includes('editor=paused')).length, 1, 'Only the current event editor remains open');
    await editor.getByText('Previous SSE events', { exact: true }).waitFor();
    const history = editor.locator('.sse-history');
    assert.equal(await history.locator('textarea:not([readonly])').count(), 0);
    await history.getByText('context', { exact: false }).first().click();
    await history.getByText('9007199254740993123', { exact: false }).waitFor();
    await eventually(() => notifications.some(item => item.type === 'event' && item.sequence === 1), 'MCP must deliver context event before the data breakpoint continues');
    assert.equal(watchFinished, false, 'Live events must arrive before the watch result');
    if (process.env.STREAMGLASS_TEST_BREAKPOINT_SCREENSHOT) await editor.screenshot({ path: process.env.STREAMGLASS_TEST_BREAKPOINT_SCREENSHOT });
    await editor.getByRole('region', { name: 'Request context', exact: true }).getByText('request-body-context', { exact: false }).waitFor();
    assert.equal(await editor.getByRole('region', { name: 'Request context', exact: true }).locator('textarea:not(.monaco-editor *)').count(), 0, 'Read-only JSON must not offer inputs');
    const eventBody = bodyEditor.getByRole('textbox', { name: 'Event data', exact: true });
    // Direct text editing: replace only the array, as a user would by selecting and typing.
    await setMonacoText(app, eventBody, (await readMonacoText(app, eventBody)).replace(/\[[^\]]*\]/, '[{"id":9007199254740993999}]'));
    const editedEvent = await readMonacoText(app, eventBody);
    assert.match(editedEvent, /\[\{"id":9007199254740993999\}\]/);
    assert.match(editedEvent, /"untouched": 9007199254740993123/);
    assert.match(editedEvent, /"exponent": 1\.00e\+40/);
    await editor.getByRole('button', { name: 'Continue', exact: true }).click();
    await eventually(() => editor.isClosed(), 'The Breakpoints window must close once its list is empty');
    editorOpened = app.waitForEvent('window');
    assert.equal(await sseResult, 'event: context\ndata: {"requestId":9007199254740993123}\n\nevent: data\n' + editedEvent.split('\n').map(line => `data: ${line}\n`).join('') + '\n', 'Untouched events retain original bytes; replacing a collapsed array changes only that subtree');
    assert.notEqual((await watched).isError, true);
    assert.deepEqual(notifications.filter(item => item.type === 'event').map(item => item.sequence), [1, 2]);
    await watchTransport.terminateSession();
    await watcher.close();
    const droppedResult = new Promise(resolve => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: `http://127.0.0.1:${fixturePort}/events` }, response => { response.resume(); response.on('end', () => resolve('response')); });
      request.setTimeout(15000, () => request.destroy(new Error('Drop timed out')));
      request.on('error', error => resolve(error.code));
      request.end();
    });
    editor = await editorOpened;
    await editor.getByRole('spinbutton', { name: 'Status code', exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Drop connection', exact: true }).click();
    await eventually(() => editor.isClosed(), 'The Breakpoints window must close once its list is empty');
    editorOpened = app.waitForEvent('window');
    assert.equal(await droppedResult, 'ECONNRESET', 'Dropping a breakpoint must close its connection');
    const passThrough = new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: `http://127.0.0.1:${fixturePort}/events` }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      request.setTimeout(15000, () => request.destroy(new Error('Pause passthrough timed out')));
      request.on('error', reject); request.end();
    });
    passThrough.catch(() => {});
    editor = await editorOpened;
    await editor.getByRole('spinbutton', { name: 'Status code', exact: true }).fill('503');
    await page.getByRole('button', { name: 'Pause capture and rules', exact: true }).click();
    await eventually(() => editor.isClosed(), 'The Breakpoints window must close once its list is empty');
    assert.deepEqual(await passThrough, { status: 200, body: 'event: context\ndata: {"requestId":9007199254740993123}\n\nevent: data\ndata: {"flights":[1,2],"untouched":9007199254740993123,"exponent":1.00e+40}\n\n' });
    assert.equal((await api('/api/state')).pending.length, 0);
    assert.equal(app.windows().filter(window => window.url().includes('editor=paused')).length, 0, 'The Breakpoints window closes when its list empties');
    await page.getByRole('button', { name: 'Resume capture and rules', exact: true }).click();
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    assert.equal(await page.locator('.inspector .headers-disclosure').evaluate(element => element.open), false);
    await page.locator('.inspector .headers-disclosure summary').click();
    await page.locator('.header-list').getByText('second', { exact: true }).waitFor();
    if (process.env.STREAMGLASS_TEST_SCREENSHOT) await page.screenshot({ path: process.env.STREAMGLASS_TEST_SCREENSHOT });
    const detached = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Detach inspector', exact: true }).click();
    const inspector = await detached;
    await inspector.getByRole('tab', { name: 'Request', exact: true }).waitFor();
    assert.match(inspector.url(), new RegExp(`record=${gate.recordId}`));
    // This is genuine TLS through CONNECT; its private path/body must stay opaque.
    await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      socket.on('error', reject);
      socket.setTimeout(15000, () => socket.destroy(new Error('HTTPS fixture timed out')));
      socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${httpsPort} HTTP/1.1\r\nHost: 127.0.0.1:${httpsPort}\r\n\r\n`));
      let handshake = '';
      const readHandshake = chunk => {
        handshake += chunk.toString();
        if (!handshake.includes('\r\n\r\n')) return;
        socket.removeListener('data', readHandshake);
        assert.match(handshake, /^HTTP\/1\.1 200/);
        const secure = tls.connect({ socket, rejectUnauthorized: false }, () => secure.write('GET /private-path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
        let response = '';
        secure.on('data', chunk => { response += chunk.toString(); });
        secure.on('error', reject);
        secure.on('end', () => { try { assert.match(response, /private-body!/); resolve(); } catch (error) { reject(error); } });
      };
      socket.on('data', readHandshake);
    });
    const tunnel = await eventually(async () => (await api('/api/state')).records.find(record => record.kind === 'tunnel' && record.port === httpsPort), 'Encrypted HTTPS connection did not appear');
    assert.equal(tunnel.method, 'CONNECT');
    assert.equal(tunnel.request, undefined);
    assert.equal(tunnel.response, undefined);
    const tunnelRow = page.getByRole('row').filter({ hasText: `127.0.0.1:${httpsPort}` });
    await tunnelRow.waitFor();
    assert.match(await tunnelRow.innerText(), /HTTPS connection/);
    assert.equal(await tunnelRow.locator('.path svg').count(), 1);
    await tunnelRow.click();
    await page.getByRole('heading', { name: 'Encrypted HTTPS connection', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Request', exact: true }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: 'Response', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Export selected request', { exact: true }).count(), 0);
    assert.equal(await page.locator('.inspector').getByText('private-body!', { exact: true }).count(), 0);
    assert.equal(await page.locator('.inspector dd').getByText(String(httpsPort), { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Enable SSL inspection…', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'SSL inspection enabled for 127.0.0.1' }).waitFor();
    await page.getByRole('button', { name: 'SSL inspection settings', exact: true }).waitFor();
    assert.deepEqual((await api('/api/state')).settings.tlsDomains, ['one.example', 'two.example', '127.0.0.1']);
    if (process.env.STREAMGLASS_TEST_HTTPS_SCREENSHOT) await page.screenshot({ path: process.env.STREAMGLASS_TEST_HTTPS_SCREENSHOT });
    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close();
    await new Promise(resolve => fixture.close(resolve));
    await new Promise(resolve => httpsFixture.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

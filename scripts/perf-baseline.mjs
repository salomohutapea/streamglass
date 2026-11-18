// Performance baseline for docs/PERFORMANCE_AUDIT.md. Seeds synthetic captures, launches the built UI in
// background mode (invisible, never focused), drives synthetic HTTP and SSE traffic through the proxy, and prints
// JSON metrics. Usage: npm run build:ui && node scripts/perf-baseline.mjs [--quick] [--skip-sse]
// Opt-in extras, which leave the default scenarios unchanged: --records=N seeds N records instead of 1,000 (the engine
// loads at most its 1,000-record limit at start, so more only grows the database);
// --ux adds cold start, table scroll/select/filter-typing latency, a large JSON body and Tools window scenarios
// (--ux-only runs just those); --trace=DIR writes a Chromium trace of every process per scenario.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const quick = process.argv.includes('--quick'), skipSse = process.argv.includes('--skip-sse');
const uxOnly = process.argv.includes('--ux-only'), ux = uxOnly || process.argv.includes('--ux');
const recordCount = Number(flag('records') ?? 1000), largeBodyMB = Number(flag('large-body-mb') ?? 8);
const traceDir = flag('trace') ? path.resolve(flag('trace')) : null;
const seconds = quick ? 8 : 20;
const now = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2) : null; };
const summary = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: percentile(values, 1) });

// A 32x32 noise PNG, close in size to the app icons Streamglass embeds in each record.
function iconPng(seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out; };
  const raw = Buffer.alloc(32 * (32 * 4 + 1)); let state = seed;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32 * 4; x++) { state = (state * 1103515245 + 12345) & 0x7fffffff; raw[y * 129 + 1 + x] = x % 4 === 3 ? 255 : (state >> 16) & 0xff; }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

function seedRecords(count) {
  const apps = [1, 2, 3].map(n => ({ id: `bundle:test.app${n}`, name: `Test App ${n}`, pid: 4000 + n, kind: 'application', icon: iconPng(n) }));
  const body = JSON.stringify({ items: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `item-${i}`, price: i * 10.5, tags: ['alpha', 'beta'] })) });
  const records = [];
  for (let i = 0; i < count; i++) {
    const sse = i % 20 === 0, startedAt = 1792123200 + i;
    const url = `https://api${i % 7}.example.test/v1/${sse ? 'stream' : 'items'}/${i}?page=${i % 5}`;
    const events = sse ? Array.from({ length: 200 }, (_, n) => { const data = JSON.stringify({ token: `tok-${n}`, pad: 'x'.repeat(200) }); const raw = `data: ${data}\n\n`;
      return { event: 'message', data, sequence: n + 1, raw, rawBase64: Buffer.from(raw).toString('base64'), receivedAt: startedAt + n / 50, gapMs: 20, forwarded: true }; }) : [];
    records.push({ id: `seed-${i}`, kind: 'request', method: sse ? 'POST' : 'GET', url, startedAt, endedAt: startedAt + .2, durationMs: 200, state: 'complete', statusCode: 200,
      application: apps[i % 3], clientIsLocal: true, device: '127.0.0.1', eventCount: events.length, isSSE: sse,
      request: { method: sse ? 'POST' : 'GET', url, headers: [['accept', sse ? 'text/event-stream' : 'application/json'], ['user-agent', 'perf-baseline']], body: '', bodyBase64: '' },
      response: { statusCode: 200, headers: [['content-type', sse ? 'text/event-stream' : 'application/json']], body: sse ? '' : body, bodyBase64: '' }, events });
  }
  return records;
}

// One extra capture with a large JSON response (--ux), as an API listing or export a user might open.
function largeBodyRecord(megabytes, startedAt) {
  const item = i => ({ id: i, sku: `SKU-${String(i).padStart(8, '0')}`, name: `Synthetic product ${i}`, price: +(i * 1.37).toFixed(2), tags: ['alpha', 'beta', 'gamma'], stock: { warehouse: `W${i % 9}`, count: i % 500 } });
  const one = JSON.stringify(item(0)).length + 1, body = JSON.stringify({ items: Array.from({ length: Math.ceil(megabytes * 2 ** 20 / one) }, (_, i) => item(i)) });
  const url = 'https://large-body.example.test/v1/export?format=json';
  return { id: 'seed-large-body', kind: 'request', method: 'GET', url, startedAt, endedAt: startedAt + .4, durationMs: 400, state: 'complete', statusCode: 200,
    clientIsLocal: true, device: '127.0.0.1', eventCount: 0, isSSE: false, events: [],
    request: { method: 'GET', url, headers: [['accept', 'application/json']], body: '', bodyBase64: '' },
    response: { statusCode: 200, headers: [['content-type', 'application/json']], body, bodyBase64: '' } };
}

async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port; }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Synthetic upstream: /items returns JSON, /stream sends `count` SSE events at `rate` per second stamped with send time.
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://upstream');
  if (url.pathname === '/stream') {
    const count = Number(url.searchParams.get('count')), interval = 1000 / Number(url.searchParams.get('rate'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sent = 0; const pad = 'y'.repeat(260);
    const timer = setInterval(() => { res.write(`data: {"n":${sent},"t":${now()},"pad":"${pad}"}\n\n`); if (++sent >= count) { clearInterval(timer); res.end(); } }, interval);
    req.on('close', () => clearInterval(timer));
    return;
  }
  const payload = JSON.stringify({ ok: true, needle: 'perf-needle', items: Array.from({ length: 20 }, (_, i) => ({ i, value: 'v'.repeat(40) })) });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }); res.end(payload);
});
const upstreamPort = await listen(upstream);

function streamThrough(proxyPort, count, rate) {
  return new Promise((resolve, reject) => {
    const target = `http://127.0.0.1:${upstreamPort}/stream?count=${count}&rate=${rate}`;
    const options = proxyPort ? { host: '127.0.0.1', port: proxyPort, path: target } : target;
    const latencies = []; let buffer = '';
    http.get(options, res => {
      res.setEncoding('utf8');
      res.on('data', text => { buffer += text; let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); const match = /"t":([\d.]+)/.exec(frame); if (match) latencies.push(now() - Number(match[1])); } });
      res.on('end', () => resolve(latencies)); res.on('error', reject);
    }).on('error', reject);
  });
}
function request(proxyPort, n) {
  const target = `http://127.0.0.1:${upstreamPort}/items/${n}`;
  return new Promise((resolve, reject) => { const start = now(); http.get(proxyPort ? { host: '127.0.0.1', port: proxyPort, path: target } : target, res => { res.resume(); res.on('end', () => resolve(now() - start)); }).on('error', reject); });
}
async function steadyHttp(proxyPort, rps, durationMs) {
  const pending = []; const end = now() + durationMs; let n = 0;
  while (now() < end) { pending.push(request(proxyPort, n++)); await sleep(1000 / rps); }
  return Promise.all(pending);
}
const latencyStats = values => ({ ...summary(values), first100: summary(values.slice(0, 100)), last100: summary(values.slice(-100)) });

const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-perf-'));
const proxyPort = await freePort();
const records = seedRecords(recordCount);
if (ux) records.push(largeBodyRecord(largeBodyMB, 1792123200 + recordCount + 60));
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2]),'listenHost':'127.0.0.1'})))
c.execute('CREATE TABLE records (id TEXT PRIMARY KEY,started REAL,payload TEXT)')
for r in json.loads(sys.stdin.read()): c.execute('INSERT INTO records VALUES (?,?,?)',(r['id'],r['startedAt'],json.dumps(r)))
c.commit()`, path.join(directory, 'captures.sqlite3'), String(proxyPort)], { input: JSON.stringify(records), maxBuffer: 1 << 30 });

const env = { ...process.env, STREAMGLASS_BACKGROUND: '1', STREAMGLASS_MCP_PORT: '0', STREAMGLASS_KEEP_CAPTURES: '1', STREAMGLASS_BUILT_UI: '1', STREAMGLASS_DATA_DIR: directory, STREAMGLASS_SETUP_PORT: String(await freePort()) };
delete env.ELECTRON_RUN_AS_NODE;
if (traceDir) await mkdir(traceDir, { recursive: true });
const launchStarted = now();
const app = await electron.launch({ args: [root, `--user-data-dir=${path.join(directory, 'chromium')}`], env, timeout: 60000 });
const results = { seeded: { records: records.length, sseRecords: records.filter(r => r.isSSE).length, eventsPerSeededStream: 200 }, scenarioSeconds: seconds };
try {
  const page = await app.firstWindow();
  if (ux) {
    // Cold start: process launch to the first painted table row. The renderer figures count from its navigation start.
    const windowMs = now() - launchStarted;
    const rendererFirstRowMs = await page.waitForFunction(() => document.querySelector('tr[data-record-id]') && performance.now(), null, { polling: 'raf', timeout: 60000 }).then(handle => handle.jsonValue());
    const launchToFirstRowMs = now() - launchStarted;
    const paint = await page.evaluate(() => ({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, domContentLoaded: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? null,
      scriptKB: Math.round(performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script' || r.name.endsWith('.js')).reduce((sum, r) => sum + (r.decodedBodySize || 0), 0) / 1024) }));
    results.coldStart = { launchToWindowMs: Math.round(windowMs), launchToFirstRowMs: Math.round(launchToFirstRowMs), rendererDomContentLoadedMs: Math.round(paint.domContentLoaded), rendererFirstContentfulPaintMs: paint.fcp == null ? null : Math.round(paint.fcp), rendererFirstRowMs: Math.round(rendererFirstRowMs) };
    console.error(`coldStart: ${JSON.stringify(results.coldStart)}`);
  }
  await page.getByRole('dialog', { name: 'Welcome tour' }).getByRole('button', { name: 'Skip tour' }).click();
  const bootstrap = await page.evaluate(() => window.streamglass.getBootstrap());
  const api = async route => (await fetch(bootstrap.baseUrl + route, { headers: { Authorization: `Bearer ${bootstrap.token}` } }));
  for (let i = 0; i < 120 && !(await (await api('/api/state')).json()).settings.proxyRunning; i++) await sleep(250);
  await page.locator('tr[data-record-id]').nth(20).waitFor();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const mainPid = app.process().pid;
  const psRows = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,command=']).toString().split('\n').map(line => line.trim().split(/\s+/));
  const helperCpu = () => Object.fromEntries([['main', row => Number(row[0]) === mainPid], ['renderer', row => Number(row[1]) === mainPid && /Renderer/.test(row.slice(4).join(' '))]].map(([key, test]) => [key, psRows().filter(test).reduce((sum, row) => sum + cpuSeconds(row[2]), 0)]));
  const engineProcess = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,command=']).toString().split('\n').map(line => line.trim().split(/\s+/)).find(([, ppid, , , ...command]) => Number(ppid) === mainPid && /python|streamglass-engine/.test(command.join(' ')));
  const cpuSeconds = time => time.split(':').reverse().reduce((total, part, i) => total + Number(part) * 60 ** i, 0);
  const transfer = { state: 0, record: 0, search: 0, stateCount: 0, recordCount: 0 };
  page.on('response', response => { const url = response.url(), size = Number(response.headers()['content-length'] ?? 0);
    if (url.includes('/api/state')) { transfer.state += size; transfer.stateCount++; } else if (url.includes('/api/records/')) { transfer.record += size; transfer.recordCount++; } else if (url.includes('/api/search')) transfer.search += size; });

  // Trace categories for --trace: the timeline DevTools records, plus compositor, GPU, scheduler and worker activity.
  const traceCategories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'v8', 'v8.execute', 'blink', 'blink.user_timing', 'cc', 'gpu', 'viz', 'renderer.scheduler', 'loading', 'latencyInfo', 'ipc', 'mojom', 'electron'];
  async function measure(name, work) {
    if (traceDir) await app.evaluate(({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] }), traceCategories);
    for (const key of Object.keys(transfer)) transfer[key] = 0;
    await app.evaluate(({ app }) => app.getAppMetrics());
    const before = (await cdp.send('Performance.getMetrics')).metrics, engineBefore = engineProcess(), helpersBefore = helperCpu(), started = now();
    const detail = await work();
    const elapsed = (now() - started) / 1000, after = (await cdp.send('Performance.getMetrics')).metrics, engineAfter = engineProcess(), helpersAfter = helperCpu();
    const metric = (list, key) => list.find(m => m.name === key)?.value ?? 0, delta = key => metric(after, key) - metric(before, key);
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage, memoryMB: p.memory.workingSetSize / 1024 })));
    const byType = type => processes.filter(p => p.type === type).reduce((sum, p) => ({ cpu: sum.cpu + p.cpu, memoryMB: sum.memoryMB + p.memoryMB }), { cpu: 0, memoryMB: 0 });
    results[name] = {
      seconds: +elapsed.toFixed(1),
      rendererMainThreadBusyPct: +(100 * delta('TaskDuration') / elapsed).toFixed(1),
      rendererScriptPct: +(100 * delta('ScriptDuration') / elapsed).toFixed(1),
      rendererLayoutStylePct: +(100 * (delta('LayoutDuration') + delta('RecalcStyleDuration')) / elapsed).toFixed(1),
      rendererJsHeapMB: +(metric(after, 'JSHeapUsedSize') / 2 ** 20).toFixed(1),
      rendererDomNodes: metric(after, 'Nodes'),
      electronCpuPct: Object.fromEntries(['Browser', 'Tab', 'GPU'].map(type => [type, +byType(type).cpu.toFixed(1)])),
      electronMemoryMB: Object.fromEntries(['Browser', 'Tab', 'GPU'].map(type => [type, Math.round(byType(type).memoryMB)])),
      psCpuPct: Object.fromEntries(Object.keys(helpersAfter).map(key => [key, +(100 * (helpersAfter[key] - helpersBefore[key]) / elapsed).toFixed(1)])),
      engineCpuPct: engineBefore && engineAfter ? +(100 * (cpuSeconds(engineAfter[2]) - cpuSeconds(engineBefore[2])) / elapsed).toFixed(1) : null,
      engineRssMB: engineAfter ? Math.round(Number(engineAfter[3]) / 1024) : null,
      rendererFetchedMBps: +((transfer.state + transfer.record + transfer.search) / elapsed / 2 ** 20).toFixed(2),
      stateFetches: transfer.stateCount, stateBytesEach: transfer.stateCount ? Math.round(transfer.state / transfer.stateCount) : 0,
      recordFetches: transfer.recordCount, recordMB: +(transfer.record / 2 ** 20).toFixed(2),
      ...detail,
    };
    console.error(`${name}: ${JSON.stringify(results[name])}`);
    if (traceDir) { const file = path.join(traceDir, `${name}.json`); await app.evaluate(({ contentTracing }, target) => contentTracing.stopRecording(target), file); console.error(`trace: ${file}`); }
  }

  // Input-to-next-frame latency for trusted input in the renderer: from the event's timestamp to a task after the
  // following animation frame, which is when the frame that reflects the handler's work has been produced.
  const installLatencyProbe = target => target.evaluate(() => {
    if (window.__perfLatency) return;
    window.__perfLatency = [];
    for (const type of ['keydown', 'click', 'input']) addEventListener(type, event => { const start = event.timeStamp; requestAnimationFrame(() => setTimeout(() => window.__perfLatency.push({ type, ms: performance.now() - start }))); }, true);
    window.__perfLongTasks = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__perfLongTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: false });
  });
  const takeLatency = async (target, type) => {
    const { latencies, longTasks } = await target.evaluate(kind => { const out = { latencies: window.__perfLatency.filter(item => !kind || item.type === kind).map(item => item.ms), longTasks: window.__perfLongTasks }; window.__perfLatency = []; window.__perfLongTasks = []; return out; }, type);
    return { ...summary(latencies), longTasks: longTasks.length, longestTaskMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0 };
  };
  const settle = target => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));

  async function uxScenarios() {
    await installLatencyProbe(page);
    const scroller = await page.evaluate(() => { const row = document.querySelector('tr[data-record-id]'); let node = row?.parentElement; while (node && !(node.scrollHeight > node.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(node).overflowY))) node = node.parentElement; if (node) node.dataset.perfScroller = '1'; return Boolean(node); });
    if (!scroller) throw new Error('Cannot find the table scroller');
    // Scroll: jump through the whole table in viewport-sized steps and time each step until the next frame is out.
    results.tableScroll = await page.evaluate(async () => {
      const element = document.querySelector('[data-perf-scroller]'), frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
      element.scrollTop = 0; await frame();
      const steps = [], long = []; const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) long.push(entry.duration); }); observer.observe({ type: 'longtask' });
      const started = performance.now();
      while (element.scrollTop + element.clientHeight < element.scrollHeight - 2) { const start = performance.now(); element.scrollTop += element.clientHeight; await frame(); steps.push(performance.now() - start); }
      const total = performance.now() - started; observer.disconnect(); element.scrollTop = 0; await frame();
      const sorted = [...steps].sort((a, b) => a - b), pick = p => +sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2);
      return { steps: steps.length, totalMs: Math.round(total), p50: pick(.5), p95: pick(.95), max: pick(1), longTasks: long.length, renderedRows: document.querySelectorAll('tr[data-record-id]').length };
    });
    console.error(`tableScroll: ${JSON.stringify(results.tableScroll)}`);
    await settle(page); await takeLatency(page);
    // Select: click a row, then move the selection with the keyboard.
    await page.locator('tr[data-record-id]').nth(3).click(); await settle(page);
    const select = await takeLatency(page, 'click');
    for (let i = 0; i < 30; i++) { await page.keyboard.press('ArrowDown'); await sleep(60); }
    await settle(page);
    results.tableSelect = { click: select, arrowDown: await takeLatency(page, 'keydown') };
    console.error(`tableSelect: ${JSON.stringify(results.tableSelect)}`);
    // Filter typing: URL filter, then a response-content filter; each keystroke re-filters every retained row.
    const filterBox = page.getByRole('textbox', { name: 'Filter requests', exact: true });
    if (!await filterBox.count()) await page.getByRole('button', { name: 'Filter requests', exact: true }).click();
    const typing = async scope => {
      await page.getByRole('combobox', { name: 'Search content' }).selectOption(scope);
      await filterBox.fill(''); await settle(page); await takeLatency(page);
      await filterBox.focus(); await page.keyboard.type('items/12', { delay: 80 }); await sleep(500); await settle(page);
      const result = { ...await takeLatency(page, 'input'), rowsShown: await page.locator('tr[data-record-id]').count() };
      await filterBox.fill(''); await settle(page); return result;
    };
    const scopes = await page.getByRole('combobox', { name: 'Search content' }).evaluate(select => [...select.options].map(option => option.value));
    results.filterTyping = { url: await typing(scopes[0]) };
    if (scopes.includes('response')) results.filterTyping.response = await typing('response');
    await page.getByRole('combobox', { name: 'Search content' }).selectOption(scopes[0]);
    console.error(`filterTyping: ${JSON.stringify(results.filterTyping)}`);
    // Large body: select the large capture and open its Response tab until the editor shows text.
    await filterBox.fill('large-body.example.test'); await page.locator('tr[data-record-id="seed-large-body"]').waitFor();
    await page.getByRole('tab', { name: 'Overview' }).click().catch(() => {});
    await settle(page); await takeLatency(page);
    const largeStarted = now();
    await page.locator('tr[data-record-id="seed-large-body"]').click();
    await page.getByRole('tab', { name: 'Response' }).click();
    await page.locator('.inspector .json-viewer .view-lines').first().waitFor({ timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.inspector .json-viewer .view-lines')?.textContent.includes('items'), null, { polling: 'raf', timeout: 120000 });
    const openMs = now() - largeStarted;
    await settle(page);
    const openLatency = await takeLatency(page);
    // Scroll the open editor, then switch away and back.
    const scrollStarted = now();
    await page.locator('.inspector .json-viewer .monaco-editor').first().hover();
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 2000); await sleep(30); }
    await settle(page);
    const scrollMs = now() - scrollStarted;
    const switchStarted = now();
    await page.getByRole('tab', { name: 'Overview' }).click(); await settle(page);
    await page.getByRole('tab', { name: 'Response' }).click();
    await page.waitForFunction(() => document.querySelector('.inspector .json-viewer .view-lines')?.textContent.includes('items'), null, { polling: 'raf', timeout: 120000 });
    const reopenMs = now() - switchStarted;
    const heap = await cdp.send('Performance.getMetrics').then(({ metrics }) => metrics.find(m => m.name === 'JSHeapUsedSize').value / 2 ** 20);
    results.largeBody = { megabytes: largeBodyMB, clickToTextMs: Math.round(openMs), openLongTasks: openLatency.longTasks, openLongestTaskMs: openLatency.longestTaskMs, wheelScroll20Ms: Math.round(scrollMs), tabSwitchBackMs: Math.round(reopenMs), rendererJsHeapMB: +heap.toFixed(1) };
    console.error(`largeBody: ${JSON.stringify(results.largeBody)}`);
    await page.getByRole('tab', { name: 'Overview' }).click();
    await filterBox.fill(''); await settle(page);
    await page.locator('tr[data-record-id]').nth(3).click(); await settle(page);
    // Tools window: click to the window's Tools region being visible, then close it.
    const toolsStarted = now();
    const opened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const tools = await opened;
    const toolsWindowMs = now() - toolsStarted;
    await tools.getByRole('region', { name: 'Tools', exact: true }).waitFor({ timeout: 30000 });
    results.toolsWindow = { clickToWindowMs: Math.round(toolsWindowMs), clickToToolsVisibleMs: Math.round(now() - toolsStarted) };
    await tools.close();
    console.error(`toolsWindow: ${JSON.stringify(results.toolsWindow)}`);
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, memoryMB: p.memory.workingSetSize / 1024 })));
    const mainMemory = await app.evaluate(() => { const usage = process.memoryUsage(); return Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Math.round(value / 2 ** 20)])); });
    results.uxMemoryMB = { ...Object.fromEntries(['Browser', 'Tab', 'GPU'].map(type => [type, Math.round(processes.filter(p => p.type === type).reduce((sum, p) => sum + p.memoryMB, 0))])), mainProcess: mainMemory };
    console.error(`uxMemoryMB: ${JSON.stringify(results.uxMemoryMB)}`);
  }

  const stateBytes = (await (await api('/api/state')).arrayBuffer()).byteLength;
  results.stateResponseBytes = stateBytes;
  if (ux) await uxScenarios();
  if (!uxOnly) {
  await measure('idleTable', () => sleep(seconds * 1000));
  await page.locator(`tr[data-record-id="seed-${recordCount - 20}"]`).click();
  await page.getByRole('tab', { name: /Events/ }).click();
  await measure('idleSseSelectedEventsTab', () => sleep(seconds * 1000));
  await page.locator(`tr[data-record-id="seed-${recordCount - 19}"]`).click();

  const sseCount = quick ? 400 : 1500;
  if (!skipSse) {
  results.directSse = latencyStats(await streamThrough(0, sseCount, 50));
  await measure('liveSse', async () => ({ eventLatencyMs: latencyStats(await streamThrough(proxyPort, sseCount, 50)) }));
  await measure('liveSseSelectedEventsTab', async () => {
    const liveRows = page.locator('tr[data-record-id]').filter({ hasText: '/stream' }).filter({ hasText: '127.0.0.1' });
    const seen = new Set(await liveRows.evaluateAll(rows => rows.map(row => row.dataset.recordId)));
    const stream = streamThrough(proxyPort, sseCount, 50);
    let id;
    while (!id) { id = (await liveRows.evaluateAll(rows => rows.map(row => row.dataset.recordId))).find(value => !seen.has(value)); if (!id) await sleep(100); }
    await page.locator(`tr[data-record-id="${id}"]`).click(); await page.getByRole('tab', { name: /Events/ }).click();
    return { eventLatencyMs: latencyStats(await stream) };
  });

    // How long the renderer stays unresponsive after the stream ends, with the live record still open.
    const recovery = now();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));
    results.rendererRecoveryAfterSseMs = Math.round(now() - recovery);
    console.error(`rendererRecoveryAfterSseMs: ${results.rendererRecoveryAfterSseMs}`);
    // Start the HTTP scenario from a fresh renderer so the Events-tab backlog doesn't skew it.
    await page.reload();
    await page.locator('tr[data-record-id]').nth(20).waitFor({ timeout: 120000 });
    await sleep(3000);
  }
  results.directHttp = summary(await steadyHttp(0, 20, 5000));
  if (!await page.getByRole('textbox', { name: 'Filter requests', exact: true }).count()) await page.getByRole('button', { name: 'Filter requests', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search content' }).selectOption('response');
  await page.getByRole('textbox', { name: 'Filter requests', exact: true }).fill('perf-needle');
  await measure('steadyHttpWithResponseFilter', async () => ({ requestLatencyMs: summary(await steadyHttp(proxyPort, 20, seconds * 1000)) }));
  }
  results.databaseMB = +((await stat(path.join(directory, 'captures.sqlite3'))).size / 2 ** 20).toFixed(1);
} finally {
  await app.close().catch(() => {});
  upstream.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));

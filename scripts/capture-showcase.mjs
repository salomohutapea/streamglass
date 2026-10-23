// Records the screenshots and motion clips for the Streamglass showcase page from the real app, driven by
// synthetic traffic only. Hostnames under localtest.me resolve to 127.0.0.1, and the fixture listens on
// port 80 (all interfaces; macOS allows that without root) so captured URLs carry no port.
// Usage: npm run build:ui && node scripts/capture-showcase.mjs <output-dir> [scene...]
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import { encodeQr } from '../frontend/src/qr-code.mjs';
import http from 'node:http';
import net from 'node:net';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outDir = path.join(root, 'showcase'), ...only] = process.argv.slice(2);
const wanted = scene => !only.length || only.includes(scene);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const API = 'http://api.localtest.me';

// --- Synthetic backend -------------------------------------------------------------------------------------
const flights = { query: { from: 'CGK', to: 'DPS', date: '2026-11-14', passengers: 2 }, currency: 'IDR', results: [
  { id: 'GA-404', airline: 'Garuda Indonesia', depart: '06:10', arrive: '09:05', durationMin: 115, price: 1485000, seatsLeft: 4 },
  { id: 'QZ-7510', airline: 'AirAsia', depart: '08:35', arrive: '11:25', durationMin: 110, price: 912000, seatsLeft: 9 },
  { id: 'JT-30', airline: 'Lion Air', depart: '11:00', arrive: '13:55', durationMin: 115, price: 834000, seatsLeft: 2 },
  { id: 'ID-6510', airline: 'Batik Air', depart: '15:45', arrive: '18:40', durationMin: 115, price: 1120000, seatsLeft: 6 },
] };
const tokens = 'Bali in mid-November is shoulder season: fewer crowds, warm days and the first afternoon showers. Fly into Denpasar early, stay two nights in Ubud for rice terraces, then finish on the Uluwatu cliffs for sunset.'.split(/(?<= )/);

function json(res, status, body, delay = 0) {
  setTimeout(() => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-Id': Math.random().toString(16).slice(2, 10) }); res.end(JSON.stringify(body)); }, delay);
}
const backend = http.createServer(async (req, res) => {
  const url = new URL(req.url, API);
  for await (const _ of req) { /* drain */ }
  if (url.pathname === '/v1/flights/search') return json(res, 200, flights, 380);
  if (url.pathname === '/v1/auth/session') return json(res, 200, { user: { id: 'u_2041', name: 'Ayu Pratama', tier: 'gold' }, expiresIn: 3600 }, 90);
  if (url.pathname === '/v1/config') return json(res, 200, { features: { newCheckout: true, assistant: true, darkMode: 'system' }, minVersion: '4.12.0' }, 40);
  if (url.pathname === '/v1/hotels') return json(res, 200, { city: 'Ubud', results: [{ id: 'h_118', name: 'Bisma Valley Retreat', rating: 4.7, nightly: 1650000 }, { id: 'h_207', name: 'Alas Harum Villas', rating: 4.5, nightly: 1280000 }] }, 260);
  if (url.pathname === '/v1/recommendations') return json(res, 200, { items: ['Uluwatu', 'Nusa Penida', 'Munduk'] }, 140);
  if (url.pathname === '/v1/cart') return json(res, 409, { error: { code: 'fare_changed', message: 'The fare changed since search. Refresh to see the new price.' } }, 120);
  if (url.pathname === '/v1/loyalty/points') return json(res, 503, { error: { code: 'upstream_timeout', message: 'Loyalty service did not respond in time.' } }, 900);
  const demo = { '/v2/cart/items': [201, { cartId: 'c_51', items: 2 }], '/v2/profile': [204], '/v2/notifications': [401, { error: 'token_expired' }],
    '/v2/checkout': [500, { error: { code: 'payment_gateway', message: 'Upstream gateway error' } }], '/v2/wishlist': [200, { items: ['h_118', 'QZ-7510'] }],
    '/oauth/token': [200, { access_token: 'demo', expires_in: 3600 }], '/v2/stores/nearby': [200, { stores: 3 }], '/v2/settings': [200, { theme: 'system' }] }[url.pathname];
  if (demo) return demo[1] ? json(res, demo[0], demo[1], 60 + url.pathname.length * 7) : setTimeout(() => { res.writeHead(demo[0]); res.end(); }, 70);
  if (url.pathname === '/v1/assistant/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`event: context\ndata: ${JSON.stringify({ conversationId: 'c_8812', model: 'trip-planner-2' })}\n\n`);
    const pace = Number(url.searchParams.get('pace') || 260);
    for (const [index, token] of tokens.entries()) {
      await sleep(pace + (index % 7 === 0 ? pace * 2 : 0));
      if (res.destroyed) return;
      res.write(`event: delta\ndata: ${JSON.stringify({ index, text: token })}\n\n`);
    }
    res.end(`event: done\ndata: ${JSON.stringify({ tokens: tokens.length, finishReason: 'stop' })}\n\n`);
    return;
  }
  json(res, 404, { error: { code: 'not_found' } });
});

// Requests go through the proxy with absolute URLs, like an app with its proxy set. They come from a child
// process running a copy of node named TripApp, so Streamglass attributes them to "TripApp" rather than "node".
function request(proxyPort, method, pathname, body) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : undefined;
    const outgoing = http.request({ host: '127.0.0.1', port: proxyPort, method, path: API + pathname, headers: {
      'User-Agent': 'TripApp/4.13.0 (iPhone; iOS 19.1)', Accept: 'application/json', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo.signature',
      ...(payload ? { 'Content-Type': 'application/json' } : {}), Cookie: 'session=s_9f2c; region=id-ID' } }, response => { response.resume(); response.on('end', resolve); response.on('error', resolve); });
    outgoing.on('error', resolve);
    outgoing.end(payload);
  });
}
if (process.argv[2] === '--client') {
  const port = Number(process.argv[3]);
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, pathname, body } = JSON.parse(line);
    void request(port, method, pathname, body).then(() => process.stdout.write(`${id}\n`));
  }
  process.exit(0);
}
let client;
const waiting = new Map();
let nextId = 0;
function send(method, pathname, body) {
  const id = ++nextId;
  client.stdin.write(JSON.stringify({ id, method, pathname, body }) + '\n');
  return new Promise(resolve => waiting.set(String(id), resolve));
}
const appStart = async gap => {
  for (const [method, pathname, body] of [['GET', '/v1/config'], ['POST', '/v1/auth/session', { device: 'iphone', locale: 'id-ID' }], ['GET', '/v1/flights/search?from=CGK&to=DPS&date=2026-11-14&pax=2'],
    ['GET', '/v1/hotels?city=ubud&checkIn=2026-11-14&nights=2'], ['GET', '/v1/recommendations?near=DPS'], ['POST', '/v1/cart', { flightId: 'QZ-7510', pax: 2 }], ['GET', '/v1/loyalty/points']]) {
    void send(method, pathname, body);
    await sleep(gap);
  }
};

// --- Frame capture -------------------------------------------------------------------------------------------
// CDP screencast gives full-resolution frames with timestamps; ffmpeg turns them into an H.264 clip.
async function record(page, name, run) {
  const dir = await mkdtemp(path.join(tmpdir(), `sg-${name}-`));
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await run();
  await sleep(400);
  await cdp.send('Page.stopScreencast');
  // Screencast only sends frames when the page changes; hold each frame until the next one at 30 fps.
  const fps = 30, start = frames[0].time, end = frames.at(-1).time + 0.6;
  let list = '';
  for (const [index, frame] of frames.entries()) {
    const file = path.join(dir, `${String(index).padStart(5, '0')}.png`);
    await writeFile(file, Buffer.from(frame.data, 'base64'));
    const duration = (frames[index + 1]?.time ?? end) - frame.time;
    list += `file '${file}'\nduration ${duration.toFixed(4)}\n`;
  }
  list += `file '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`;
  await writeFile(path.join(dir, 'frames.txt'), list);
  const output = path.join(outDir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-vf', `fps=${fps},scale=1600:-2:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', output]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-0.1', '-i', output, '-frames:v', '1', '-q:v', '3', path.join(outDir, `${name}-poster.jpg`)]);
  await rm(dir, { recursive: true, force: true });
  console.log(`${name}.mp4: ${frames.length} frames, ${(end - start).toFixed(1)}s`);
}
// Page screenshots leave out the native window buttons; draw them where macOS puts them for the README image.
const drawLights = (page, y = 20) => page.evaluate(top => {
  const lights = document.createElement('div');
  lights.id = 'showcase-lights';
  lights.style.cssText = `position:fixed;left:16px;top:${top}px;display:flex;gap:8px;z-index:99999;pointer-events:none`;
  for (const color of ['#ff5f57', '#febc2e', '#28c840']) { const dot = document.createElement('i'); dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.25)`; lights.append(dot); }
  document.body.append(lights);
}, y);
const removeLights = page => page.evaluate(() => document.getElementById('showcase-lights')?.remove());

async function still(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '--resampleWidth', '1600', path.join(outDir, `${name}.png`), '--out', path.join(outDir, `${name}.jpg`)], { stdio: 'ignore' });
  await rm(path.join(outDir, `${name}.png`));
  console.log(`${name}.jpg`);
}
const sizeWindow = (app, page, width, height) => app.evaluate(({ BrowserWindow }, [title, width, height]) => {
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(title)) ?? BrowserWindow.getAllWindows()[0];
  win.setContentSize(width, height); win.center();
}, [page.url(), width, height]);

// --- Run ---------------------------------------------------------------------------------------------------------
await mkdir(outDir, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-showcase-'));
// Prefer the default ports so the setup screen shows 9090/9091. Listen on localhost so the header shows
// 127.0.0.1 rather than this Mac's LAN address; the Connect Device scene turns LAN access on and masks it.
const free = port => new Promise(resolve => { const probe = net.createServer().once('error', () => resolve(false)).listen(port, () => probe.close(() => resolve(true))); });
let proxyPort = 0;
for (const port of [9090, 8888]) if (!proxyPort && await free(port) && await free(port + 1)) proxyPort = port;
if (!proxyPort) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  proxyPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
}
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2]),'listenHost':'127.0.0.1'})))
c.commit()`, path.join(directory, 'captures.sqlite3'), String(proxyPort)]);
await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(80, resolve); });
const tripApp = path.join(directory, 'TripApp');
await copyFile(process.execPath, tripApp);
await chmod(tripApp, 0o755);
client = spawn(tripApp, [fileURLToPath(import.meta.url), '--client', String(proxyPort)], { stdio: ['pipe', 'pipe', 'inherit'] });
createInterface({ input: client.stdout }).on('line', id => { waiting.get(id)?.(); waiting.delete(id); });

const env = { ...process.env, STREAMGLASS_MCP_PORT: '0', STREAMGLASS_KEEP_CAPTURES: '1', STREAMGLASS_BUILT_UI: '1', STREAMGLASS_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root, `--user-data-dir=${path.join(directory, 'chromium')}`, '--force-device-scale-factor=2'], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('dialog', { name: 'Welcome tour' }).getByRole('button', { name: 'Skip tour' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  // Traffic from 127.0.0.1 is what the iOS Simulator sends; label it that way.
  await page.evaluate(() => localStorage.setItem('streamglass.deviceLabels', JSON.stringify({ '127.0.0.1': { name: 'iPhone 17 Pro Simulator', icon: 'ios', color: '#7c9cff' } })));
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Use dark theme', exact: true }).count()) await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await sizeWindow(app, page, 1440, 860);
  await sleep(800);

  const bootstrap = await page.evaluate(() => window.streamglass.getBootstrap());
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(bootstrap.baseUrl + route, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${route}: ${await response.text()}`);
    return response.json();
  };
  const row = text => page.locator('tbody tr', { hasText: text }).first();

  // 1. Live traffic: requests land in the table, then an SSE stream is inspected while it is open.
  if (wanted('live')) await record(page, 'live-traffic', async () => {
    await sleep(900);
    const stream = send('GET', '/v1/assistant/stream?pace=230');
    await appStart(420);
    await sleep(300);
    await row('/v1/assistant/stream').click();
    await page.getByRole('tab', { name: /^Events/ }).click();
    await stream;
    await sleep(1600);
  });
  else { const stream = send('GET', '/v1/assistant/stream?pace=20'); await appStart(120); await stream; }
  if (wanted('stills')) {
    await row('/v1/assistant/stream').click();
    await page.getByRole('tab', { name: /^Events/ }).click();
    await sleep(500);
    await still(page, 'sse-timeline');
    await row('/v1/flights/search').click();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await sleep(500);
    await still(page, 'inspector-timing');
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    await sleep(600);
    await still(page, 'inspector-response');
  }

  // README: a full window with a range of methods and statuses and a JSON response open.
  if (wanted('readme')) {
    for (const [method, pathname, body] of [['POST', '/oauth/token', { grant: 'password' }], ['GET', '/v2/settings'], ['GET', '/v2/stores/nearby?lat=-6.2&lng=106.8'], ['GET', '/v2/wishlist'],
      ['POST', '/v2/checkout', { cartId: 'c_51' }], ['GET', '/v2/notifications'], ['PUT', '/v2/profile', { name: 'Ayu' }], ['POST', '/v2/cart/items', { sku: 'QZ-7510' }]]) { await send(method, pathname, body); await sleep(120); }
    await sizeWindow(app, page, 1440, 868);
    await row('/v1/flights/search').click();
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    await sleep(900);
    await drawLights(page);
    await page.screenshot({ path: path.join(outDir, 'readme.png') });
    await removeLights(page);
    await sizeWindow(app, page, 1440, 860);
    console.log('readme.png');
  }

  // 2. Breakpoint: pause the flight search response, change a fare, continue.
  if (wanted('breakpoint')) {
    await api('/api/rules', 'PUT', { revision: (await api('/api/state')).rulesRevision, rules: [{ id: 'fare', name: 'Flight search fares', enabled: true, method: 'GET', pattern: `${API}/v1/flights/search*`, stages: ['response'], breakpoint: true }] });
    const opened = app.waitForEvent('window');
    const request = send('GET', '/v1/flights/search?from=CGK&to=DPS&date=2026-11-21&pax=2');
    const editor = await opened;
    await editor.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    await sizeWindow(app, editor, 1280, 800);
    await sleep(1200);
    const body = editor.getByRole('textbox', { name: 'Body', exact: true });
    await body.waitFor({ state: 'attached' });
    await record(editor, 'breakpoint', async () => {
      await sleep(1200);
      // Find the AirAsia fare (Find leaves it selected after Escape) and type a new one.
      await body.focus();
      await editor.keyboard.press('Meta+F');
      await editor.keyboard.type('912000', { delay: 70 });
      await editor.keyboard.press('Escape');
      await sleep(300);
      await editor.keyboard.type('99000', { delay: 110 });
      await sleep(900);
      await editor.getByRole('button', { name: 'Continue', exact: true }).hover();
      await sleep(500);
      await editor.getByRole('button', { name: 'Continue', exact: true }).click();
      await sleep(1600);
    });
    await request;
    await api('/api/rules', 'PUT', { revision: (await api('/api/state')).rulesRevision, rules: [] });
  }

  // 3. Phone setup: Connect Device on step 2 with local network access on.
  if (wanted('connect')) {
    await page.locator('.connect-button').click();
    await page.getByRole('radio', { name: /iOS Device/ }).click();
    const section = page.getByRole('region', { name: 'Phone setup page QR code' });
    await section.waitFor();
    await sleep(800);
    const lan = section.getByRole('button', { name: 'Turn on local network access', exact: true });
    if (await lan.isVisible()) await lan.click();
    await section.getByRole('button', { name: 'Copy setup URL' }).waitFor();
    await sleep(600);
    // Show a placeholder LAN address instead of this Mac's, with a QR code that matches it.
    const lanIps = Object.values(networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address);
    const shown = '192.168.1.24', qrText = `http://${shown}:${proxyPort + 1}/`;
    const qr = encodeQr(qrText), quiet = 3, side = qr.size + quiet * 2;
    let qrPath = '';
    qr.modules.forEach((line, r) => { let c = 0; while (c < qr.size) { if (!line[c]) { c++; continue; } const start = c; while (c < qr.size && line[c]) c++; qrPath += `M${start + quiet} ${r + quiet}h${c - start}v1h${start - c}z`; } });
    await page.evaluate(([ips, shown, side, qrPath]) => {
      const swap = text => ips.reduce((value, ip) => value.split(ip).join(shown), text);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) node.nodeValue = swap(node.nodeValue);
      for (const input of document.querySelectorAll('input, option')) { if ('value' in input) input.value = swap(input.value); }
      const svg = document.querySelector('.qr-code');
      if (svg) svg.innerHTML = `<rect width="${side}" height="${side}" fill="#fff"/><path d="${qrPath}" fill="#000"/>`, svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
    }, [lanIps, shown, side, qrPath]);
    await sleep(600);
    await still(page, 'connect-device');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // 4. Tools: traffic rules and the MCP setup for agents.
  if (wanted('tools')) {
    const tools = await api('/api/traffic-tools');
    const common = (id, name, pattern) => ({ id, name, enabled: true, pattern, method: '*', group: 'Staging' });
    await api('/api/traffic-tools', 'PUT', { revision: tools.revision, config: { ...tools.config,
      mapRemoteRules: [{ ...common('staging', 'Production API to staging', 'https://api.tripapp.example/*'), scheme: 'https', host: 'staging-api.tripapp.example', port: 0, pathFrom: '/v1', pathTo: '/v1', keepHost: false,
        headerOps: [{ op: 'set', name: 'X-Session-Id', value: 'staging-session' }] }],
      rewriteRules: [{ ...common('slow-loyalty', 'Loyalty outage', `${API}/v1/loyalty/*`), phase: 'response', headerOps: [], statusCode: 503, bodyFind: '', bodyReplace: '' }],
      blockRules: [{ ...common('ads', 'Block ad SDK', 'https://ads.example/*'), action: 'respond', statusCode: 403, body: 'Blocked by Streamglass' }] } });
    const opened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const toolsWindow = await opened;
    await toolsWindow.getByRole('navigation', { name: 'Tools navigation' }).waitFor();
    await sizeWindow(app, toolsWindow, 1280, 800);
    await toolsWindow.getByRole('navigation', { name: 'Tools navigation' }).getByRole('button', { name: 'Map Remote', exact: true }).click();
    await sleep(700);
    await still(toolsWindow, 'tools-map-remote');
    await toolsWindow.getByRole('navigation', { name: 'Tools navigation' }).getByRole('button', { name: 'Agent (MCP)', exact: true }).click();
    await sleep(700);
    await still(toolsWindow, 'tools-mcp');
  }
} finally {
  await app.close().catch(() => {});
  backend.close();
  client?.kill();
  await rm(directory, { recursive: true, force: true });
}

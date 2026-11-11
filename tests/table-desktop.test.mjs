import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { _electron as electron } from 'playwright';

let sidebarNudge = 0;
async function openFilter(page) { if (!await page.getByRole('textbox', { name: 'Filter requests', exact: true }).count()) await page.getByRole('button', { name: 'Filter requests', exact: true }).click(); }
async function openSidebar(page) { for (let attempt = 0; attempt < 6; attempt++) { await page.mouse.move(600, 400); await page.locator('.sidebar').hover({ position: { x: 10 + (sidebarNudge++ % 7), y: 150 + (attempt % 3) * 20 } }); await page.waitForTimeout(60); if (await page.locator('.sidebar:hover').count()) return; } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('table search, sorting, SSE labels, JSON and row actions', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-table-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const appIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
  const records = [
    { id: 'fixture-z', kind: 'request', method: 'POST', url: 'https://example.test/z-search/sse', startedAt: 1792123202.123,
      application: { id: 'bundle:safari', name: 'Safari', pid: 42, kind: 'application', icon: appIcon }, clientIsLocal: true,
      device: 'test-device', state: 'complete', statusCode: 200, isSSE: true, eventCount: 1,
      request: { method: 'POST', url: 'https://example.test/z-search/sse', headers: [['X-Request', 'request-only']], body: '{"query":"request-only"}', bodyBase64: '' },
      response: { statusCode: 200, headers: [['content-type', 'text/event-stream']], body: '', bodyBase64: '' },
      events: [{ event: 'data', data: '{"flight":"event-only","id":9007199254740993123,"ok":true}', sequence: 1 }] },
    { id: 'fixture-a', kind: 'request', method: 'GET', url: 'https://example.test/a-json', startedAt: 1792123201.456,
      application: { id: 'pid:43', name: 'curl', pid: 43, kind: 'process', icon: 'https://example.test/untrusted.png' }, clientIsLocal: true,
      device: 'test-device', state: 'complete', statusCode: 201, eventCount: 0,
      request: { method: 'GET', url: 'https://example.test/a-json', headers: [], body: '', bodyBase64: '' },
      response: { statusCode: 201, headers: [['content-type', 'application/json']], body: '{"message":"response-only","n":9007199254740993123,"safe":"<script>alert(1)</script>"}', bodyBase64: '' }, events: [] },
    { id: 'fixture-lock', kind: 'tunnel', isEncrypted: true, host: 'locked.example.test', port: 443, method: 'CONNECT', url: 'locked.example.test:443', startedAt: 1792123203.789, application: null, clientIsLocal: true, device: 'test-device', state: 'error', error: 'Encrypted tunnel interrupted to enable SSL inspection; reconnecting requests will be inspected.', eventCount: 0, events: [] },
  ];
  execFileSync(path.join(root, '.venv/bin/python'), ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2])})))
c.execute('CREATE TABLE records (id TEXT PRIMARY KEY,started REAL,payload TEXT)')
for r in json.loads(sys.stdin.read()): c.execute('INSERT INTO records VALUES (?,?,?)',(r['id'],r['startedAt'],json.dumps(r)))
c.commit()`, path.join(directory, 'captures.sqlite3'), String(port)], { input: JSON.stringify(records) });
  let app;
  try {
    const env = { ...process.env, STREAMGLASS_MCP_PORT: '0', STREAMGLASS_KEEP_CAPTURES: '1', STREAMGLASS_BUILT_UI: '1', STREAMGLASS_DATA_DIR: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.STREAMGLASS_TEST_APP;
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(directory, 'chromium')}`], env });
    const page = await app.firstWindow();
    await page.getByRole('dialog',{name:'Welcome tour'}).getByRole('button',{name:'Skip tour'}).click();
    // Control menu focus explicitly: the host may keep a different app/window foreground.
    await app.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      BrowserWindow.getFocusedWindow = () => BrowserWindow.getAllWindows().sort((a, b) => b.id - a.id)[0];
      app.emit('browser-window-focus', {}, main);
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function menuItem(id) {
      return app.evaluate(({ app, BrowserWindow, Menu }, itemId) => {
        app.emit('browser-window-focus', {}, BrowserWindow.getFocusedWindow());
        const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
        return item && { label: item.label, enabled: item.enabled, checked: item.checked, accelerator: item.accelerator };
      }, id);
    }
    async function clickMenu(id) {
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
      let item = await menuItem(id);
      for (let attempt = 0; !item?.enabled && attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        item = await menuItem(id);
      }
      assert.ok(item?.enabled, `Menu ${id} must be enabled`);
      await app.evaluate(({ Menu, BrowserWindow }, itemId) => {
        const item = Menu.getApplicationMenu().getMenuItemById(itemId);
        item.click(item, BrowserWindow.getFocusedWindow(), {});
      }, id);
    }
    const rows = page.locator('tbody tr');
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    assert.equal(await page.locator('tbody tr.incoming-row').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Stop proxy', exact: true }).count(), 0);
    assert.equal(await page.locator('.toolbar button[aria-label$="capture and rules"]').count(), 1);
    assert.equal(await page.getByRole('textbox', { name: 'Filter requests' }).count(), 0, 'The filter bar opens on demand');
    await page.keyboard.press('Meta+f');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Filter requests');
    const searchStyle = await page.locator('.filter-input').evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius }; });
    assert.notEqual(searchStyle.background, 'rgba(0, 0, 0, 0)');
    assert.equal(searchStyle.border, '1px');
    assert.notEqual(searchStyle.radius, '0px');
    await openSidebar(page);
    const deviceRow = page.locator('.device-row').filter({ hasText: 'test-device' });
    await openSidebar(page);
    await deviceRow.hover();
    await deviceRow.getByRole('button', { name: 'Customize test-device', exact: true }).click();
    const deviceDialog = page.getByRole('dialog');
    await deviceDialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Flight Pixel');
    await deviceDialog.getByLabel('Color', { exact: true }).fill('#e6a355');
    await deviceDialog.getByRole('combobox', { name: 'Icon', exact: true }).selectOption('android');
    await deviceDialog.getByRole('button', { name: 'Save label', exact: true }).click();
    await openSidebar(page);
    await deviceRow.getByText('Flight Pixel', { exact: false }).waitFor();
    await openSidebar(page);
    assert.equal(await deviceRow.locator('.device-name').evaluate(element => getComputedStyle(element).textAlign), 'left');
    await openSidebar(page);
    assert.equal(await deviceRow.locator('svg[aria-label="Android"]').evaluate(element => getComputedStyle(element).color), 'rgb(230, 163, 85)');
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await openSidebar(page);
    await deviceRow.getByText('Flight Pixel', { exact: false }).waitFor();
    assert.equal(await page.locator('tbody tr.incoming-row').count(), 0);
    await openSidebar(page);
    await deviceRow.hover();
    await deviceRow.getByRole('button', { name: 'Customize Flight Pixel', exact: true }).click();
    assert.equal(await deviceDialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Flight Pixel');
    assert.equal(await deviceDialog.getByLabel('Color', { exact: true }).inputValue(), '#e6a355');
    assert.equal(await deviceDialog.getByRole('combobox', { name: 'Icon', exact: true }).inputValue(), 'android');
    await deviceDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    if (process.env.STREAMGLASS_TEST_DEVICE_SCREENSHOT) await page.screenshot({ path: process.env.STREAMGLASS_TEST_DEVICE_SCREENSHOT });
    await openSidebar(page);
    const applicationsToggle = page.getByRole('button', { name: 'Applications', exact: true });
    await openSidebar(page);
    await applicationsToggle.click();
    await openSidebar(page);
    assert.equal(await applicationsToggle.getAttribute('aria-expanded'), 'false');
    await openSidebar(page);
    assert.equal(await page.locator('.application-row:visible').count(), 0);
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await openSidebar(page);
    assert.equal(await page.getByRole('button', { name: 'Applications', exact: true }).getAttribute('aria-expanded'), 'false');
    await openSidebar(page);
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await openSidebar(page);
    const devicesToggle = page.getByRole('button', { name: 'Devices', exact: true });
    await openSidebar(page);
    await devicesToggle.click();
    await openSidebar(page);
    assert.equal(await devicesToggle.getAttribute('aria-expanded'), 'false');
    await openSidebar(page);
    assert.equal(await page.getByRole('button', { name: 'All devices', exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await openSidebar(page);
    assert.equal(await page.getByRole('button', { name: 'Devices', exact: true }).getAttribute('aria-expanded'), 'false');
    await openSidebar(page);
    await page.getByRole('button', { name: 'Connect a device', exact: true }).click();
    await page.getByRole('dialog', { name: 'Connect a device' }).waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    await openSidebar(page);
    assert.equal(await page.getByRole('button', { name: 'All devices', exact: true }).count(), 1);
    await openSidebar(page);
    const safari = page.locator('.application-row').filter({ hasText: 'Safari' });
    assert.equal(await safari.locator('img').getAttribute('src'), appIcon);
    assert.equal(await safari.locator('img').evaluate(image => image.complete && image.naturalWidth === 1), true);
    await openSidebar(page);
    assert.equal(await page.locator('.application-row img[src^="http"]').count(), 0);
    await safari.click();
    await openSidebar(page);
    await page.locator('.sidebar-section-toggle[aria-controls="sidebar-applications"]').click();
    assert.equal(await page.locator('tbody tr').count(), 1, 'collapsing Applications preserves its selected filter');
    await openSidebar(page);
    await page.locator('.sidebar-section-toggle[aria-controls="sidebar-applications"]').click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.match(await rows.first().innerText(), /z-search\/sse/);
    await rows.first().click();
    await page.locator('.inspector dd').getByText('Safari', { exact: true }).waitFor();
    await openSidebar(page);
    await page.locator('.application-row').filter({ hasText: 'curl' }).click();
    await page.getByRole('row').filter({ hasText: 'a-json' }).waitFor();
    assert.equal(await rows.count(), 1);
    await openSidebar(page);
    await page.locator('.application-row').filter({ hasText: 'Unknown app' }).click();
    await page.getByRole('row').filter({ hasText: 'locked.example.test' }).waitFor();
    assert.equal(await rows.count(), 1);
    await page.getByRole('button', { name: /^SSE \d/ }).click();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await openSidebar(page);
    assert.equal(await page.locator('.application-row[aria-pressed="true"]').count(), 0);
    await safari.click();
    await openSidebar(page);
    await deviceRow.locator('.nav-row').click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    await openSidebar(page);
    assert.equal(await page.locator('.application-row[aria-pressed="true"]').count(), 0);
    await openSidebar(page);
    await deviceRow.hover();
    const deviceWidth = await deviceRow.evaluate(element => {
      const row = element.getBoundingClientRect(), button = element.querySelector('.nav-row').getBoundingClientRect(), actions = element.querySelector('.device-row-actions').getBoundingClientRect();
      return { row: row.width, button: button.width, actions: actions.width, labelRight: button.right, actionsLeft: actions.left, actionsRight: actions.right, rowRight: row.right, selected: getComputedStyle(element).backgroundColor, editPosition: getComputedStyle(element.querySelector('.icon-button')).position };
    });
    assert.ok(Math.abs(deviceWidth.row - deviceWidth.button - deviceWidth.actions) < 1, 'Device label and inline actions fill the selected row');
    assert.ok(deviceWidth.labelRight <= deviceWidth.actionsLeft + 1, 'Device label does not overlap actions');
    assert.ok(deviceWidth.actionsRight <= deviceWidth.rowRight + 1, 'Device actions stay inside the row');
    assert.notEqual(deviceWidth.selected, 'rgba(0, 0, 0, 0)');
    assert.equal(deviceWidth.editPosition, 'static');
    await safari.click();
    await openFilter(page);
    const applicationQuery = page.getByRole('textbox', { name: 'Filter requests' });
    await applicationQuery.fill('a-json');
    await page.getByRole('heading', { name: 'No matching requests', exact: true }).waitFor();
    assert.equal(await rows.count(), 0);
    await applicationQuery.fill('z-search');
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await page.getByRole('columnheader', { name: /Request/ }).getByRole('button').click();
    assert.equal(await rows.count(), 1);
    await applicationQuery.fill('');
    await openSidebar(page);
    await page.getByRole('button', { name: /^All requests/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    // Restore the initial selection for the existing native menu assertions.
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    assert.equal((await menuItem('export-request')).enabled, false);
    await clickMenu('settings');
    await page.getByRole('dialog').waitFor();
    assert.equal((await menuItem('clear-all')).enabled, false);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal(await page.getByRole('columnheader', { name: 'Status', exact: true }).count(), 1);
    assert.equal(await page.getByRole('columnheader', { name: 'Time', exact: false }).count(), 0);
    await page.getByRole('button', { name: 'Choose table columns', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: /Time/ }).click();
    await page.keyboard.press('Escape');
    assert.match(await page.getByRole('row').filter({ hasText: 'z-search/sse' }).innerText(), /POST\s*\|\s*SSE/);
    for (const time of await rows.locator('.timing').allTextContents()) assert.match(time, /\d{2}:\d{2}:\d{2}/);
    for (const field of ['Method', 'Request', 'Time']) {
      const header = page.getByRole('columnheader', { name: new RegExp(field) });
      await header.getByRole('button').click();
      const first = await rows.allTextContents();
      await header.getByRole('button').click();
      assert.deepEqual(await rows.allTextContents(), [...first].reverse());
    }
    await openFilter(page);
    const scope = page.getByRole('combobox', { name: 'Search content' });
    const mode = page.getByRole('combobox', { name: 'Match mode' });
    const query = page.getByRole('textbox', { name: 'Filter requests' });
    for (const [target, value, expected] of [['request', 'request-only', 'z-search/sse'], ['response', 'response-only', 'a-json'], ['event', 'event-only', 'z-search/sse']]) {
      await scope.selectOption(target);
      await query.fill(value);
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
      assert.match(await rows.first().innerText(), new RegExp(expected));
    }
    await scope.selectOption('url');
    await mode.selectOption('wildcard');
    await query.fill('*a-json');
    await page.getByRole('row').filter({ hasText: 'a-json' }).waitFor();
    await rows.first().click();
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    await page.locator('.inspector').getByText('9007199254740993123', { exact: false }).waitFor();
    assert.equal(await page.locator('.inspector script').count(), 0);
    assert.equal(await page.locator('.inspector .headers-disclosure').evaluate(element => element.open), false);
    assert.equal(await page.locator('.inspector-content').evaluate(element => element.querySelector('.json-viewer').compareDocumentPosition(element.querySelector('.headers-disclosure')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
    await page.locator('.inspector .headers-disclosure summary').click();
    await page.locator('.inspector .header-list').getByText('application/json', { exact: true }).waitFor();
    await query.fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    const target = page.getByRole('row').filter({ hasText: 'z-search/sse' });
    const exportPath = path.join(directory, 'clicked-request.json');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Export request', exact: true }).click();
    let exported;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { exported = JSON.parse(await readFile(exportPath, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(exported?.url, 'https://example.test/z-search/sse');
    const allExportPath = path.join(directory, 'all-captures.json');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, allExportPath);
    await query.fill('*a-json');
    await page.getByRole('row').filter({ hasText: 'a-json' }).waitFor();
    await clickMenu('export-all');
    let allExport;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { allExport = JSON.parse(await readFile(allExportPath, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(allExport?.format, 'streamglass-session');
    assert.equal(allExport?.version, 1);
    assert.equal(allExport?.recordCount, 3);
    assert.ok(Number.isFinite(Date.parse(allExport.exportedAt)));
    for (const record of records) {
      const saved = allExport.records.find(item => item.id === record.id);
      assert.ok(saved, `Export must retain ${record.id} despite active search`);
      for (const field of ['request', 'response', 'events']) if (record[field] !== undefined) {
        if (field === 'events') assert.deepEqual(saved[field], record[field]);
        else for (const [key, value] of Object.entries(record[field])) assert.deepEqual(saved[field][key], value);
      }
    }
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    await page.getByRole('button', { name: 'Export all captures', exact: true }).click();
    await query.fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    await target.click({ button: 'right' });
    let opened = app.waitForEvent('window');
    await page.getByRole('menuitem', { name: 'Add breakpoint…', exact: true }).click();
    let editor = await opened;
    assert.equal(await (await app.browserWindow(editor)).evaluate(window => window.isFullScreenable()), false);
    assert.equal(await (await app.browserWindow(editor)).evaluate(window => window.isFullScreen()), false);
    let pattern = editor.getByRole('textbox', { name: 'URL wildcard', exact: false });
    await pattern.waitFor();
    assert.match(await pattern.inputValue(), /z-search\/sse/);
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('POST https://example.test/z-search/sse');
    assert.equal(await editor.getByRole('heading', { name: 'New breakpoint', exact: true }).count(), 1);
    assert.equal(await editor.getByRole('button', { name: 'Add rule', exact: true }).count(), 0, 'A breakpoint opened from a request shows only its form');
    const closed = editor.waitForEvent('close');
    await editor.getByRole('button', { name: 'Save rule', exact: true }).click();
    await closed;
    opened = app.waitForEvent('window');
    await clickMenu('breakpoints');
    editor = await opened;
    await editor.getByRole('button', { name: 'Add rule', exact: true }).waitFor();
    // Rules and folders share one compact table: folders are rows that expand in place.
    const ruleRow = editor.locator('.rule-table tbody tr.rule-item-row');
    const folderRow = name => editor.locator('.rule-table tbody tr.rule-folder-row').filter({ has: editor.getByText(name, { exact: true }) });
    const tableShape = () => editor.locator('.rule-table tbody tr').evaluateAll(rows => rows.map(row => `${row.getAttribute('aria-level')}:${row.classList.contains('rule-folder-row') ? 'F ' + row.querySelector('strong').textContent : row.querySelector('code').textContent}`));
    assert.equal(await ruleRow.count(), 1);
    assert.equal(await ruleRow.locator('code').textContent(), 'https://example.test/z-search/sse');
    await editor.getByRole('button', { name: 'New folder', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Flight search');
    await editor.getByRole('button', { name: 'Create folder', exact: true }).click();
    await folderRow('Flight search').waitFor();
    await editor.getByRole('button', { name: 'Edit POST https://example.test/z-search/sse', exact: true }).click();
    await editor.getByRole('combobox', { name: 'Folder', exact: true }).selectOption({ label: 'Flight search' });
    await editor.getByRole('button', { name: 'Save rule', exact: true }).click();
    await editor.waitForFunction(() => document.querySelector('.rule-table tr.rule-item-row')?.getAttribute('aria-level') === '2');
    assert.deepEqual(await tableShape(), ['1:F Flight search', '2:https://example.test/z-search/sse']);
    // A folder inside a folder, created from the folder's menu.
    await editor.getByRole('button', { name: 'Folder actions for Flight search', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'New folder inside…', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('SSE');
    await editor.getByRole('button', { name: 'Create folder', exact: true }).click();
    await folderRow('SSE').waitFor();
    assert.equal(await folderRow('SSE').getAttribute('aria-level'), '2');
    // Rename from the menu.
    await editor.getByRole('button', { name: 'Folder actions for Flight search', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Flight SSE');
    await editor.getByRole('button', { name: 'Save folder', exact: true }).click();
    await folderRow('Flight SSE').waitFor();
    // Keyboard sort: Option+Down moves the rule below its sibling folder, and the engine stores that order.
    assert.deepEqual(await tableShape(), ['1:F Flight SSE', '2:F SSE', '2:https://example.test/z-search/sse']);
    await editor.getByRole('button', { name: 'New folder', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Later');
    await editor.getByRole('button', { name: 'Create folder', exact: true }).click();
    await folderRow('Later').waitFor();
    const before = await tableShape();
    await folderRow('Later').focus();
    await editor.keyboard.press(before[0] === '1:F Later' ? 'Alt+ArrowDown' : 'Alt+ArrowUp');
    await editor.waitForFunction(first => document.querySelector('.rule-table tbody tr strong')?.textContent !== first, before[0].slice(4));
    assert.notDeepEqual(await tableShape(), before, 'Option+Arrow reorders a folder among its siblings');
    // Drag the rule into the nested folder.
    await ruleRow.dragTo(folderRow('SSE'));
    await editor.waitForFunction(() => document.querySelector('.rule-table tr.rule-item-row')?.getAttribute('aria-level') === '3');
    // Turning the outer folder off turns off the rule inside it; collapsing hides its contents and is remembered.
    await editor.getByRole('checkbox', { name: 'Enable folder Flight SSE', exact: true }).click();
    await editor.waitForFunction(() => document.querySelector('.rule-table tr.rule-item-row input')?.checked === false);
    await editor.getByRole('checkbox', { name: 'Enable folder Flight SSE', exact: true }).click();
    await editor.waitForFunction(() => document.querySelector('.rule-table tr.rule-item-row input')?.checked === true);
    if (process.env.STREAMGLASS_TEST_RULES_SCREENSHOT) await editor.screenshot({ path: process.env.STREAMGLASS_TEST_RULES_SCREENSHOT });
    await editor.getByRole('button', { name: 'Collapse Flight SSE', exact: true }).click();
    await editor.waitForFunction(() => !document.querySelector('.rule-table tr.rule-item-row'));
    assert.equal(await folderRow('Flight SSE').locator('small').textContent(), '1', 'A collapsed folder still shows how many rules it holds');
    await editor.getByRole('button', { name: 'Expand Flight SSE', exact: true }).click();
    await ruleRow.waitFor();
    // Deleting a folder keeps what was inside it, one level up.
    await editor.getByRole('button', { name: 'Folder actions for Flight SSE', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Delete folder…', exact: true }).click();
    await editor.getByRole('alertdialog').getByRole('button', { name: 'Delete folder', exact: true }).click();
    await editor.waitForFunction(() => ![...document.querySelectorAll('.rule-table tr.rule-folder-row strong')].some(element => element.textContent === 'Flight SSE'));
    assert.equal(await ruleRow.count(), 1);
    assert.equal(await folderRow('SSE').getAttribute('aria-level'), '1');
    assert.equal(await ruleRow.getAttribute('aria-level'), '2');
    await editor.close();
    await target.click({ button: 'right' });
    opened = app.waitForEvent('window');
    await page.getByRole('menuitem', { name: 'Create JavaScript rule…', exact: true }).click();
    editor = await opened;
    pattern = editor.getByRole('textbox', { name: 'URL wildcard', exact: false });
    await pattern.waitFor();
    assert.match(await pattern.inputValue(), /z-search\/sse/);
    await editor.close();
    await target.focus();
    await target.press('Shift+F10');
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await clickMenu('inspect-events');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent.startsWith('Events') && tab.getAttribute('aria-selected') === 'true'));
    assert.equal(await page.getByRole('tab', { name: /Events/ }).getAttribute('aria-selected'), 'true');
    opened = app.waitForEvent('window');
    await clickMenu('breakpoints');
    editor = await opened;
    await editor.getByRole('button', { name: 'Add rule', exact: true }).waitFor();
    assert.equal((await menuItem('capture-toggle')).enabled, false);
    await editor.close();
    await page.bringToFront();
    opened = app.waitForEvent('window');
    await clickMenu('script-new');
    editor = await opened;
    pattern = editor.getByRole('textbox', { name: 'URL wildcard', exact: false });
    await pattern.waitFor();
    assert.match(await pattern.inputValue(), /z-search\/sse/);
    await editor.close();
    await page.bringToFront();
    await clickMenu('capture-toggle');
    await page.getByRole('button', { name: 'Resume capture and rules', exact: true }).waitFor();
    await clickMenu('capture-toggle');
    await page.getByRole('button', { name: 'Pause capture and rules', exact: true }).waitFor();
    await clickMenu('proxy-toggle');
    await page.getByRole('button', { name: 'Start capture and rules', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start capture and rules', exact: true }).click();
    await page.getByRole('button', { name: 'Pause capture and rules', exact: true }).waitFor();
    await clickMenu('capture-toggle');
    await page.getByRole('button', { name: 'Resume capture and rules', exact: true }).waitFor();
    await clickMenu('proxy-toggle');
    await page.getByRole('button', { name: 'Start capture and rules', exact: true }).waitFor();
    await clickMenu('capture-toggle');
    await page.getByRole('button', { name: 'Pause capture and rules', exact: true }).waitFor();
    const locked = page.getByRole('row').filter({ hasText: 'locked.example.test' });
    await locked.click();
    await page.getByRole('heading', { name: 'Encrypted HTTPS connection', exact: true }).waitFor();
    await page.getByText('Interrupted for SSL inspection', { exact: true }).waitFor();
    assert.equal(await page.locator('.inspector .error-text').count(), 0);
    await page.getByRole('button', { name: 'Enable SSL inspection…', exact: true }).waitFor();
    assert.equal((await menuItem('export-request')).enabled, false);
    assert.equal((await menuItem('breakpoint-new')).enabled, false);
    const setupBootstrap = await page.evaluate(() => window.streamglass.getBootstrap());
    await app.evaluate(({ ipcMain }, bootstrap) => {
      ipcMain.removeHandler('bootstrap');
      ipcMain.handle('bootstrap', () => ({ ...bootstrap, lanAddresses: ['192.0.2.10', '192.0.2.20'] }));
    }, setupBootstrap);
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'z-search/sse' }).waitFor();
    await page.evaluate(() => {
      window.streamglassTestCopied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.streamglassTestCopied.push(value); } } });
    });
    // Stub device IPC so setup coverage never changes the host proxy or simulator trust.
    await app.evaluate(({ ipcMain }) => {
      const inventory = { activeNetworkId: 'USB LAN', monitorEnabled: false, savedProxyTargets: [], networkNotice: 'Detected active network: USB LAN (en6).', proxyPort: 8080,
        simulatorNotice: 'Select a booted simulator and prepare capture.',
        simulators: [{ id: 'sim-booted', name: 'Test phone', state: 'Booted' }, { id: 'sim-stopped', name: 'Stopped phone', state: 'Shutdown' }],
        networkServices: [{ id: 'USB LAN', name: 'USB LAN', interface: 'en6', active: true, proxyEnabled: false, canRestore: false }, { id: 'Wi-Fi', name: 'Wi-Fi', interface: 'en0', proxyEnabled: false, canRestore: false }] };
      globalThis.streamglassTestDeviceActions = [];
      globalThis.streamglassTestCopied = [];
      ipcMain.removeHandler('copy-text');
      ipcMain.handle('copy-text', (_event, value) => { globalThis.streamglassTestCopied.push(value); });
      ipcMain.removeHandler('list-devices');
      ipcMain.removeHandler('device-action');
      ipcMain.handle('list-devices', () => inventory);
      ipcMain.handle('device-action', (_event, input) => {
        globalThis.streamglassTestDeviceActions.push(input);
        if (input.action.startsWith('mac-') || input.action === 'simulator-prepare') {
          const networkId = input.action === 'simulator-prepare' ? input.networkTarget || inventory.activeNetworkId : input.target || inventory.activeNetworkId;
          const network = inventory.networkServices.find(item => item.id === networkId);
          network.proxyEnabled = input.action !== 'mac-restore-proxy';
          network.canRestore = input.action !== 'mac-restore-proxy';
          inventory.monitorEnabled = input.action !== 'mac-restore-proxy';
          inventory.savedProxyTargets = inventory.monitorEnabled ? [`mac:${network.id}`] : [];
        }
        return { message: 'Fixture device action complete', devices: inventory };
      });
    });
    await openSidebar(page);
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    const setup = page.getByRole('dialog');
    await setup.getByRole('button', { name: 'Next', exact: true }).click();
    const proxyAddress = setup.getByRole('region', { name: 'HTTP proxy address', exact: true });
    assert.equal(await proxyAddress.getByRole('textbox', { name: 'Proxy IP address', exact: true }).inputValue(), '127.0.0.1');
    await setup.getByRole('button', { name: 'Back', exact: true }).click();
    await setup.getByRole('radio', { name: /^iOS Device/ }).click();
    const proxyIP = proxyAddress.getByRole('combobox', { name: 'Proxy IP address', exact: true });
    assert.equal(await proxyIP.inputValue(), '192.0.2.10');
    assert.deepEqual(await proxyIP.locator('option').allTextContents(), ['192.0.2.10', '192.0.2.20']);
    await proxyIP.selectOption('192.0.2.20');
    const displayedPort = await proxyAddress.getByRole('textbox', { name: 'Proxy port', exact: true }).inputValue();
    assert.equal(displayedPort, String(port));
    for (const [label, feedback] of [['Copy IP', 'IP address copied'], ['Copy port', 'Port copied'], ['Copy IP:port', 'IP:port copied']]) {
      await proxyAddress.getByRole('button', { name: label, exact: true }).click();
      await proxyAddress.getByRole('status').getByText(feedback, { exact: true }).waitFor();
    }
    assert.deepEqual(await app.evaluate(() => globalThis.streamglassTestCopied), ['192.0.2.20', displayedPort, `192.0.2.20:${displayedPort}`]);
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('copy-text'); ipcMain.handle('copy-text', () => { throw new Error('Clipboard blocked'); }); });
    await proxyAddress.getByRole('button', { name: 'Copy IP:port', exact: true }).click();
    const manualCopy = proxyAddress.getByRole('textbox', { name: 'Copy proxy value manually', exact: true });
    await manualCopy.waitFor();
    assert.equal(await manualCopy.inputValue(), `192.0.2.20:${displayedPort}`);
    assert.equal(await manualCopy.evaluate(input => input.readOnly && input.selectionStart === 0 && input.selectionEnd === input.value.length), true);
    assert.equal(await setup.getByRole('combobox', { name: 'Network service', exact: true }).count(), 0);
    await setup.getByRole('button', { name: 'Back', exact: true }).click();
    await setup.getByRole('radio', { name: /^iOS Simulator/ }).click();
    assert.equal(await proxyAddress.getByRole('textbox', { name: 'Proxy IP address', exact: true }).inputValue(), '127.0.0.1');
    const simulator = setup.getByRole('combobox', { name: 'Simulator', exact: true });
    assert.equal(await setup.getByRole('combobox', { name: 'Mac network service', exact: true }).count(), 0);
    assert.equal(await simulator.inputValue(), 'sim-booted');
    const prepare = setup.getByRole('button', { name: 'Prepare simulator capture', exact: true });
    assert.equal(await setup.getByRole('button', { name: 'Enable Mac capture', exact: true }).count(), 0);
    assert.equal(await setup.getByRole('button', { name: 'Install certificate', exact: true }).count(), 0);
    await prepare.click();
    await page.waitForFunction(() => document.querySelector('.setup-output')?.textContent === 'Fixture device action complete');
    assert.equal(await simulator.inputValue(), 'sim-booted');
    assert.equal(await setup.getByRole('button', { name: 'Disable Mac capture', exact: true }).isDisabled(), false);
    await simulator.selectOption('sim-stopped');
    assert.equal(await prepare.isDisabled(), true);
    await setup.getByRole('button', { name: 'Disable Mac capture', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Disable Mac capture')?.disabled);
    assert.deepEqual(await app.evaluate(() => globalThis.streamglassTestDeviceActions), [
      { action: 'simulator-prepare', target: 'sim-booted', networkTarget: '' }, { action: 'mac-restore-proxy', target: '', networkTarget: undefined },
    ]);
    await simulator.selectOption('sim-booted');
    await setup.getByText('Certificate-only setup for a managed Mac', { exact: true }).click();
    await setup.getByRole('button', { name: 'Install certificates only', exact: true }).click();
    assert.deepEqual((await app.evaluate(() => globalThis.streamglassTestDeviceActions)).at(-1), { action: 'simulator-certificates', target: 'sim-booted', networkTarget: undefined });
    await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
    if (process.env.STREAMGLASS_TEST_TABLE_SCREENSHOT) await page.screenshot({ path: process.env.STREAMGLASS_TEST_TABLE_SCREENSHOT });
    if (process.env.STREAMGLASS_TEST_HEADER_SCREENSHOT) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('editor=') && !win.webContents.getURL().includes('record='))?.setContentSize(900, 700));
      await page.screenshot({ path: process.env.STREAMGLASS_TEST_HEADER_SCREENSHOT });
    }
    async function dismissBulk(trigger) {
      // Bulk deletes ask in an in-app dialog: Cancel is focused, and nothing is deleted until Delete is clicked.
      await trigger();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.waitFor();
      assert.match(await confirmation.innerText(), /cannot be undone/i);
      assert.equal(await confirmation.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement), true, 'Cancel is the default action');
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await confirmation.waitFor({ state: 'detached' });
      assert.equal(await rows.count(), 3, 'Canceling bulk delete keeps every capture');
    }
    await dismissBulk(() => page.getByRole('button', { name: 'Delete all records', exact: true }).click());
    await openSidebar(page);
    await deviceRow.hover();
    await dismissBulk(() => deviceRow.getByRole('button', { name: 'Delete Flight Pixel and its records', exact: true }).click());
    await dismissBulk(() => clickMenu('clear-all'));
    await openSidebar(page);
    await deviceRow.locator('.nav-row').click();
    await dismissBulk(() => clickMenu('clear-device'));
    await locked.click();
    let unexpectedDialog = false;
    const rejectUnexpectedDialog = async dialog => { unexpectedDialog = true; await dialog.dismiss(); };
    page.on('dialog', rejectUnexpectedDialog);
    await page.getByRole('row').filter({ hasText: 'a-json' }).getByRole('button', { name: 'Delete request', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
    assert.equal(unexpectedDialog, false, 'Single capture delete is immediate');
    assert.match(await page.locator('tbody tr.selected').innerText(), /locked.example.test/, 'Deleting a row must preserve the existing selection');
    await clickMenu('clear-selected');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.equal(unexpectedDialog, false, 'Native single capture delete is immediate');
    page.off('dialog', rejectUnexpectedDialog);
    await page.getByRole('button', { name: 'Delete all records', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'Ready when you are', exact: true }).waitFor();
    assert.equal(await rows.count(), 0);
    assert.deepEqual(errors, []);

  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

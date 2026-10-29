import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

let sidebarNudge = 0;
async function openSidebar(page) { for (let attempt = 0; attempt < 6; attempt++) { await page.mouse.move(600, 400); await page.locator('.sidebar').hover({ position: { x: 10 + (sidebarNudge++ % 7), y: 150 + (attempt % 3) * 20 } }); await page.waitForTimeout(60); if (await page.locator('.sidebar:hover').count()) return; } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('pins, quick filters, columns, layouts, tools and platform setup', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-workbench-'));
  const records = [
    { id: 'plain', method: 'GET', url: 'http://example.test/plain', statusCode: 404, isSSE: false },
    { id: 'events', method: 'POST', url: 'https://example.test/events', statusCode: 200, isSSE: true, eventCount: 1 },
    { id: 'opaque', method: 'CONNECT', url: 'example.test:443', kind: 'tunnel', isEncrypted: true, statusCode: 200 },
  ].map((value, index) => ({ kind: 'request', state: 'complete', device: 'fixture-device', startedAt: 1792123200 + index, request: { headers: [], body: '' }, response: { headers: [], body: '' }, ...value }));
  execFileSync(path.join(root, '.venv/bin/python'), ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyEnabled':False})))
c.execute('CREATE TABLE records (id TEXT PRIMARY KEY,started REAL,payload TEXT)')
for r in json.loads(sys.stdin.read()): c.execute('INSERT INTO records VALUES (?,?,?)',(r['id'],r['startedAt'],json.dumps(r)))
c.commit()`, path.join(directory, 'captures.sqlite3')], { input: JSON.stringify(records) });
  let app;
  try {
    const env = { ...process.env, STREAMGLASS_MCP_PORT: '0', STREAMGLASS_KEEP_CAPTURES: '1', STREAMGLASS_BUILT_UI: '1', STREAMGLASS_DATA_DIR: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.STREAMGLASS_TEST_APP;
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(directory, 'chromium')}`], env });
    const page = await app.firstWindow();
    await page.getByRole('dialog',{name:'Welcome tour'}).getByRole('button',{name:'Skip tour'}).click();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const rows = page.locator('tbody tr');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    await page.getByRole('group', { name: 'Protocol filters' }).getByRole('button', { name: 'HTTPS', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
    await page.getByRole('group', { name: 'Status filters' }).getByRole('button', { name: '2xx', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.match(await rows.innerText(), /events/);
    await page.getByRole('group', { name: 'Status filters' }).getByRole('button', { name: '2xx', exact: true }).click();
    await page.getByRole('group', { name: 'Protocol filters' }).getByRole('button', { name: 'HTTPS', exact: true }).click();
    const events = page.getByRole('row').filter({ hasText: '/events' });
    await events.getByRole('button', { name: 'Pin request', exact: true }).click();
    await events.getByRole('button', { name: 'Unpin request', exact: true }).waitFor();
    await openSidebar(page);
    await page.getByRole('button', { name: /^Pinned/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.match(await rows.innerText(), /events/);
    await rows.first().click();
    await page.getByRole('button', { name: 'Inspector below', exact: true }).click();
    await page.getByRole('button', { name: 'Choose table columns', exact: true }).click();
    const columnMenu = page.getByRole('menu');
    await columnMenu.getByRole('menuitemcheckbox', { name: /Device/ }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('columnheader', { name: /Device/ }).waitFor();
    await page.reload();
    await page.getByRole('row').filter({ hasText: '/events' }).waitFor();
    await page.getByRole('row').filter({ hasText: '/events' }).getByRole('button', { name: 'Unpin request', exact: true }).waitFor();
    await page.getByRole('columnheader', { name: /Device/ }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('streamglass.inspector.position')), 'below');
    if (process.env.STREAMGLASS_FEATURE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.STREAMGLASS_FEATURE_SCREENSHOTS, 'workbench.png') });

    let openedTools=app.waitForEvent('window');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    let toolsPage=await openedTools;
    let tools=toolsPage.getByRole('region', { name: 'Tools', exact: true });
    assert.equal(await (await app.browserWindow(toolsPage)).evaluate(window=>window.isModal()),false);
    assert.equal(await (await app.browserWindow(toolsPage)).evaluate(window=>window.isFullScreenable()),false);
    await page.getByRole('group',{name:'Protocol filters'}).getByRole('button',{name:'HTTP',exact:true}).click();
    assert.equal(await toolsPage.isClosed(),false,'Traffic controls must remain usable with Tools open');
    await page.getByRole('group',{name:'Protocol filters'}).getByRole('button',{name:'HTTP',exact:true}).click();
    assert.equal(await page.getByRole('button', { name: 'Traffic tools', exact: true }).count(), 0);
    await tools.getByRole('button', { name: 'Map Local', exact: true }).click();
    assert.equal(await tools.locator('.lab-tabs button').evaluateAll(buttons => buttons.every(button => getComputedStyle(button).justifyContent === 'flex-start')), true);
    await tools.getByRole('button', { name: 'Add rule', exact: true }).click();
    await tools.getByLabel('Name', { exact: true }).fill('Fixture response');
    await tools.getByLabel('URL pattern', { exact: true }).fill('https://example.test/*');
    await tools.getByRole('button', { name: 'Network Conditioner', exact: true }).click();
    await page.getByRole('button',{name:'Tools',exact:true}).click();
    await tools.getByRole('button',{name:'Sessions',exact:true}).waitFor();
    assert.equal(app.windows().filter(window=>window.url().includes('editor=tools')).length,1,'Opening Tools again reuses the window');
    await tools.getByRole('button', { name: 'Map Local', exact: true }).click();
    assert.equal(await tools.getByLabel('Name', { exact: true }).inputValue(), 'Fixture response', 'Navigation must preserve unsaved traffic settings');
    await tools.getByRole('button', { name: 'Save traffic settings', exact: true }).click();
    await tools.getByRole('button', { name: 'Save traffic settings', exact: true }).waitFor();
    await tools.getByRole('button', { name: 'Close tools', exact: true }).click();
    await page.getByRole('button', { name: /Map Local · 1/ }).waitFor();
    openedTools=app.waitForEvent('window');
    await page.getByRole('button', { name: /Map Local · 1/ }).click();
    toolsPage=await openedTools;tools=toolsPage.getByRole('region',{name:'Tools',exact:true});
    await tools.getByText('Fixture response', { exact: true }).waitFor();
    await tools.getByRole('button', { name: 'Network Conditioner', exact: true }).click();
    await tools.getByLabel('Enable network profile', { exact: true }).check();
    await tools.getByLabel('Delay (ms)', { exact: true }).fill('125');
    if (process.env.STREAMGLASS_FEATURE_SCREENSHOTS) await toolsPage.screenshot({ path: path.join(process.env.STREAMGLASS_FEATURE_SCREENSHOTS, 'network.png') });
    await tools.getByRole('button', { name: 'Save traffic settings', exact: true }).click();
    await tools.getByRole('button', { name: 'Save traffic settings', exact: true }).waitFor();
    await tools.getByRole('button', { name: 'Close tools', exact: true }).click();
    await page.getByRole('button', { name: /Network conditioning/ }).waitFor();

    for (const [platform, label] of [['macos', 'This Mac'], ['ios-simulator', 'iOS Simulator'], ['ios-device', 'iPhone or iPad'], ['android-emulator', 'Android emulator'], ['android-device', 'Android device']]) {
      await app.evaluate(({ app, BrowserWindow, Menu }, id) => {
        const win = BrowserWindow.getAllWindows()[0];
        BrowserWindow.getFocusedWindow = () => win;
        app.emit('browser-window-focus', {}, win);
        const item = Menu.getApplicationMenu().getMenuItemById(id);
        if (!item?.enabled) throw new Error(`Disabled platform setup ${id}`);
        item.click(item, win, {});
      }, `setup-${platform}`);
      await page.getByRole('dialog', { name: 'Connect a device' }).waitFor();
      const selectedPlatform = { macos: 'This Mac', 'ios-simulator': 'iOS Simulator', 'ios-device': 'iOS Device', 'android-emulator': 'Android Emulator', 'android-device': 'Android Device' }[platform];
      assert.equal(await page.getByRole('dialog', { name: 'Connect a device' }).getByRole('heading', { level: 3 }).first().textContent(), selectedPlatform, label);
      if (platform === 'android-device') {
        const dialog = page.getByRole('dialog', { name: 'Connect a device' });
        assert.equal(await dialog.getByText('No ADB needed.', {exact:false}).isVisible(), true);
        const helpers = dialog.locator('details.optional-adb');
        assert.equal(await helpers.getAttribute('open'), null);
        assert.equal(await dialog.getByRole('combobox', {name:'ADB device', exact:true}).isVisible(), false);
        assert.equal(await dialog.getByRole('button', {name:'Enable proxy', exact:true}).isVisible(), false);
        await helpers.locator('summary').click();
        // Collapsibles animate open, so wait for the content rather than checking at once.
        await dialog.getByRole('combobox', {name:'ADB device', exact:true}).waitFor({state:'visible'});
        assert.equal(await dialog.getByRole('button', {name:'Enable proxy', exact:true}).isDisabled(), true);
      }
      await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    }
    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

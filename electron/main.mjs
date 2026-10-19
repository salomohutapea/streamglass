import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startScriptService } from './script-service.mjs';
import { createUpdateChecker, releasesPrefix } from './updater.mjs';
import { createDeviceService } from './devices.mjs';
import { createApplicationMenu } from './menu.mjs';
import { startMcpServer } from './mcp-server.mjs';
import { loadMcpConfig, saveMcpConfig } from './mcp-config.mjs';
import { createApplicationResolver } from './applications.mjs';
import { exportSession, importSession } from './export-session.mjs';
import { readMapLocalFile } from './map-local-file.mjs';
import { createWorkspaceService } from './workspaces.mjs';
import { validateToolsInput, validateToolsAction } from './tools-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('Streamglass');
if (process.env.STREAMGLASS_DATA_DIR) app.setPath('userData', path.resolve(process.env.STREAMGLASS_DATA_DIR));
const token = randomBytes(32).toString('hex');
const windows = new Set();
const editorWindows = new Map();
const openedGates = new Set();
const dev = !app.isPackaged && process.env.STREAMGLASS_BUILT_UI !== '1';
let engine, scriptService, devices, bootstrap, shuttingDown = false, checkingQuit = false;
let startupError = '';
let applicationMenu;
let pendingTimer;
let mcpService;
let startupReady = false;
let toolsWindow, toolsOwner, mainWindow;
let toolsContext = {section:'Sessions'};
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address))];
}

function trusted(event) {
  const url = new URL(event.senderFrame?.url || 'about:blank');
  if (!windows.has(BrowserWindow.fromWebContents(event.sender)) || event.senderFrame !== event.sender.mainFrame ||
    !(url.protocol === 'app:' && url.hostname === 'streamglass' || dev && url.origin === 'http://127.0.0.1:5173')) throw new Error('Untrusted IPC sender');
}
function handle(channel, callback) { ipcMain.handle(channel, async (event, ...args) => { trusted(event); return callback(event, ...args); }); }

function windowURL(recordId, editor) {
  const url = new URL(dev ? 'http://127.0.0.1:5173' : 'app://streamglass/index.html');
  if (recordId) url.searchParams.set('record', recordId);
  if (editor) {
    url.searchParams.set('editor', editor.type);
    if (editor.recordId) url.searchParams.set('record', editor.recordId);
    if (editor.token) url.searchParams.set('gate', editor.token);
  }
  return url.href;
}

function createWindow(recordId, editor) {
  const auxiliary = Boolean(editor || recordId);
  const win = new BrowserWindow({
    width: editor ? editor.type === 'breakpoints' ? 760 : 980 : recordId ? 1100 : 1480,
    height: editor ? editor.type === 'breakpoints' ? 560 : 820 : 940,
    minWidth: editor ? 600 : 900, minHeight: editor ? 400 : 600,
    title: 'Streamglass', backgroundColor: '#17191e',
    fullscreenable: !auxiliary,
    icon: path.join(root, 'electron/assets/streamglass.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: path.join(root, 'electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (auxiliary && process.platform === 'darwin') {
    win.setFullScreenable(false);
    win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  windows.add(win);
  if (!auxiliary && process.platform === 'darwin') {
    const syncFullScreen = () => { if (!win.isDestroyed()) void win.webContents.executeJavaScript(`document.documentElement.toggleAttribute('data-fullscreen', ${win.isFullScreen()})`).catch(() => {}); };
    win.on('enter-full-screen', syncFullScreen);
    win.on('leave-full-screen', syncFullScreen);
    win.webContents.on('did-finish-load', syncFullScreen);
  }
  applicationMenu?.register(win, !!recordId, !!editor && editor.type !== 'tools', editor?.type === 'tools');
  if (!recordId && !editor) mainWindow = win;
  win.on('closed', () => { windows.delete(win); applicationMenu?.forget(win); });
  win.webContents.on('did-start-loading', () => applicationMenu?.forget(win));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  void win.loadURL(windowURL(recordId, editor));
  return win;
}

function openToolsWindow(source, input) {
  const value = validateToolsInput(input);
  const focus = value.focus !== false;
  const exists = toolsWindow && !toolsWindow.isDestroyed();
  if (!focus && (!exists || toolsOwner !== source)) return false;
  if (!exists && windows.size >= 8) throw new Error('Close a window before opening Tools');
  const {focus:_focus, ...context} = value;
  toolsContext = {...toolsContext, ...context};
  if (focus) toolsOwner = source;
  if (!exists) {
    toolsWindow = createWindow(undefined, {type:'tools'});
    toolsWindow.setSize(1100, 850);
    toolsWindow.on('closed', () => {toolsWindow = undefined; toolsOwner = undefined;});
  } else toolsWindow.webContents.send('menu-action', 'tools-context', context);
  if (focus) {toolsWindow.restore(); toolsWindow.focus();}
  return true;
}

function toolsTrafficWindow() {
  if (toolsOwner && !toolsOwner.isDestroyed()) return toolsOwner;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return createWindow();
}

const aboutLinks = {
  issues: 'https://github.com/salomohutapea/streamglass/issues/new/choose',
  repository: 'https://github.com/salomohutapea/streamglass',
  license: 'https://github.com/salomohutapea/streamglass/blob/main/LICENSE',
  email: 'mailto:me@salomo.dev?subject=Streamglass',
};
let aboutWindow;
function openAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) { aboutWindow.show(); aboutWindow.focus(); return; }
  const win = aboutWindow = new BrowserWindow({
    width: 380, height: 560, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'About Streamglass', backgroundColor: '#17191e',
    icon: path.join(root, 'electron/assets/streamglass.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: path.join(root, 'electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  windows.add(win);
  applicationMenu?.register(win, false, true, false);
  win.on('closed', () => { windows.delete(win); applicationMenu?.forget(win); aboutWindow = undefined; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const url = new URL(windowURL());
  url.searchParams.set('about', '1');
  void win.loadURL(url.href);
}

function openEditor(input, automatic = false) {
  if (!input || !['breakpoints', 'scripts', 'paused'].includes(input.type) ||
      Object.keys(input).some(key => !['type', 'recordId', 'token'].includes(key)) ||
      ['recordId', 'token'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input[key]))) ||
      input.type === 'paused' && (!input.token || !input.recordId)) throw new Error('Invalid editor');
  const key = `${input.type}:${input.type === 'paused' ? input.token : input.recordId || ''}`;
  let win = editorWindows.get(key);
  if (win && !win.isDestroyed()) {
    const url = windowURL(undefined, input);
    if (win.webContents.getURL() !== url) void win.loadURL(url);
    win.restore();
    win.focus();
  } else {
    if (windows.size >= 8) {
      if (automatic) return false;
      throw new Error('Close a window before opening another editor');
    }
    win = createWindow(undefined, input);
    editorWindows.set(key, win);
    win.on('closed', () => editorWindows.delete(key));
  }
  if (input.type === 'paused') openedGates.add(input.token);
  return true;
}

async function pollPendingEditors() {
  try {
    const response = await fetch(`${bootstrap.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Cannot read breakpoints');
    const state = await response.json();
    const pending = state.settings?.capturePaused ? [] : state.pending ?? [];
    if (shuttingDown) return;
    const active = new Set(pending.map(gate => gate.token));
    for (const gate of openedGates) if (!active.has(gate)) {
      openedGates.delete(gate);
      const editor = editorWindows.get(`paused:${gate}`);
      if (editor && !editor.isDestroyed()) editor.close();
    }
    for (const gate of pending) {
      // Keep closed gates dismissed; a later token for the same flow opens its editor again.
      if (!openedGates.has(gate.token)) openEditor({ type: 'paused', recordId: gate.recordId, token: gate.token }, true);
    }
  } catch { /* Retry after engine restarts or temporary connection failures. */ }
  finally { if (!shuttingDown) pendingTimer = setTimeout(() => void pollPendingEditors(), 500); }
}

async function start() {
  await app.whenReady();
  app.dock?.setIcon(path.join(root, 'electron/assets/streamglass.png'));
  applicationMenu = createApplicationMenu({ app, Menu, BrowserWindow, windows, openAbout: openAboutWindow,
    getToolsOwner:() => toolsOwner && !toolsOwner.isDestroyed() ? toolsOwner : mainWindow && !mainWindow.isDestroyed() ? mainWindow : null });
  handle('menu-state', (event, state) => applicationMenu.updateState(BrowserWindow.fromWebContents(event.sender), state));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'streamglass') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const folder = path.join(root, 'frontend/dist');
    const file = path.resolve(folder, relative);
    if (!file.startsWith(folder + path.sep)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'");
    return new Response(response.body, { status: response.status, headers });
  });
  const dataDir = app.getPath('userData');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  bootstrap = {
    baseUrl: `http://127.0.0.1:${port}`, token,
    lanAddresses: lanAddresses(),
  };
  const applications = createApplicationResolver({ getFileIcon: (file, options) => app.getFileIcon(file, options) });
  scriptService = await startScriptService(token, {
    resolveApplication: async connection => ({ clientIsLocal: applications.isLocalHost(connection.clientHost), application: await applications.resolve(connection) }),
    resolveApplicationIcon: id => applications.resolveIcon(id),
  });
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'engine/streamglass-engine') : process.env.STREAMGLASS_PYTHON || path.join(root, '.venv/bin/python');
  const args = [...(app.isPackaged ? [] : ['-m', 'backend']), '--port', String(port), '--data-dir', dataDir];
  engine = spawn(executable, args, {
    cwd: app.isPackaged ? process.resourcesPath : root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STREAMGLASS_TOKEN: token, STREAMGLASS_SCRIPT_URL: scriptService.url, PYTHONUNBUFFERED: '1' },
  });
  engine.stderr.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-6000); });
  // Drain stdout without persisting traffic or secrets in a second log.
  engine.stdout.on('data', () => {});
  engine.on('error', error => { startupError = error.message; });
  engine.on('exit', code => {
    if (!shuttingDown && windows.size) dialog.showErrorBox('Proxy engine stopped', `The engine exited (${code}). Restore any configured system/device proxy before quitting.\n${startupError}`);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (engine.exitCode !== null || startupError.includes('ENOENT')) break;
    try {
      const response = await fetch(`${bootstrap.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local process to bind. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`The proxy engine could not start. For source development install Python dependencies into .venv.\n${startupError}`);

  const workspaceApi = async (method = 'GET', value) => {
    const response = await fetch(`${bootstrap.baseUrl}/api/workspace-config`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || 'Workspace configuration failed');
    return result;
  };
  const workspaces = await createWorkspaceService({ file: path.join(dataDir, 'workspaces.json'),
    readConfig: () => workspaceApi(), applyConfig: value => workspaceApi('PUT', value) });
  handle('workspaces-list', () => workspaces.list());
  handle('workspaces-save', (_event, value) => workspaces.save(value));
  handle('workspaces-load', (_event, value) => workspaces.load(value));
  handle('workspaces-rename', (_event, value) => workspaces.rename(value));
  handle('workspaces-delete', (_event, value) => workspaces.delete(value));

  const mcpFile = path.join(dataDir, 'mcp.json');
  let mcpConfig;
  let mcpError = '';
  const mcpPort = Number(process.env.STREAMGLASS_MCP_PORT ?? 48722);
  const mcpConnection = () => ({ running: Boolean(mcpService), url: mcpService?.url ?? `http://127.0.0.1:${mcpPort}/mcp`, sseUrl: mcpService?.sseUrl ?? `http://127.0.0.1:${mcpPort}/sse`, token: mcpConfig?.token ?? '', error: mcpError });
  async function enableMcp(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Expected boolean');
    if (!mcpConfig) throw new Error(mcpError || 'MCP configuration unavailable');
    if (mcpService) { await mcpService.close(); mcpService = undefined; }
    mcpError = '';
    try {
      if (enabled) mcpService = await startMcpServer({ port: mcpPort, authToken: mcpConfig.token, bootstrap, workspaces });
      mcpConfig.enabled = enabled;
      await saveMcpConfig(mcpFile, mcpConfig);
    } catch (error) { mcpError = error.message; }
    return mcpConnection();
  }
  try { mcpConfig = await loadMcpConfig(mcpFile); if (mcpConfig.enabled) await enableMcp(true); }
  catch (error) { mcpError = error.message; }
  let mcpOperation = Promise.resolve();
  handle('mcp-connection', () => mcpConnection());
  handle('mcp-enabled', (_event, enabled) => {
    const operation = mcpOperation.then(() => enableMcp(enabled));
    mcpOperation = operation.catch(() => {});
    return operation;
  });

  const deviceServiceForCurrentPort = async () => {
    if (checkingQuit && devices) return devices.service;
    const response = await fetch(`${bootstrap.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Cannot read proxy settings');
    const { settings } = await response.json();
    if (checkingQuit && devices) return devices.service;
    if (!devices || devices.port !== settings.proxyPort) {
      const replacing = Boolean(devices);
      await devices?.service.dispose();
      if (checkingQuit && devices) return devices.service;
      devices = { port: settings.proxyPort, service: createDeviceService({
        dataDir, certificatePath: path.join(dataDir, 'mitmproxy/mitmproxy-ca-cert.pem'), proxyPort: settings.proxyPort,
        getProxyHost: () => lanAddresses()[0] || '127.0.0.1',
        ensureProxyListening: async () => {
          const response = await fetch(`${bootstrap.baseUrl}/api/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ proxyEnabled: true }) });
          if (!response.ok) throw new Error('Cannot start proxy listener. Check Proxy settings before enabling Mac monitoring.');
        },
      }) };
      if (replacing) await devices.service.restoreMonitor({ startListener: false }).catch(() => {});
    }
    return devices.service;
  };
  const initialDevices = await deviceServiceForCurrentPort();
  let monitorRestoreError = '';
  try { await initialDevices.restoreMonitor(); } catch (error) { monitorRestoreError = error.message; }
  handle('bootstrap', () => ({ ...bootstrap, lanAddresses: lanAddresses() }));
  handle('copy-text', (_event, value) => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024 * 1024) throw new Error('Invalid clipboard text');
    clipboard.writeText(value);
  });
  handle('detach-inspector', (_event, id) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid record');
    if (windows.size >= 8) throw new Error('Close an inspector window before opening another');
    createWindow(id);
  });
  handle('open-editor', (_event, input) => openEditor(input));
  handle('open-tools', (event, input) => openToolsWindow(BrowserWindow.fromWebContents(event.sender), input));
  handle('tools-context', event => {
    if (BrowserWindow.fromWebContents(event.sender) !== toolsWindow) throw new Error('Tools context is only available in the Tools window');
    return toolsContext;
  });
  handle('tools-action', (event, input) => {
    if (BrowserWindow.fromWebContents(event.sender) !== toolsWindow) throw new Error('Tools actions require the Tools window');
    const value = validateToolsAction(input);
    const owner = toolsTrafficWindow();
    owner.webContents.send('menu-action', value.action === 'select-capture' ? 'tools-select-capture' : 'tools-apply-view', value);
    owner.restore(); owner.focus();
  });
  handle('pick-map-local-file', async event => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose Map Local response body (maximum 32 MiB)', properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return null;
    return readMapLocalFile(filePaths[0]);
  });
  handle('export-file', async (event, file) => {
    if (!file || typeof file.name !== 'string' || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 64 * 1024 * 1024) throw new Error('Invalid export');
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: path.basename(file.name) });
    if (canceled || !filePath) return { saved: false };
    await writeFile(filePath, file.content, { mode: 0o600 });
    return { saved: true };
  });
  handle('export-all-captures', async event => {
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      defaultPath: `streamglass-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      filters: [{ name: 'Streamglass session', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    await exportSession({ ...bootstrap, destination: filePath });
    return { saved: true };
  });
  handle('session-file', async (event, input) => {
    if (!input || typeof input !== 'object' || !['import', 'export'].includes(input.action) || Object.keys(input).some(key => !['action', 'sessionId'].includes(key))) throw new Error('Invalid session file action');
    if (input.action === 'import') {
      const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Import saved capture session', properties: ['openFile'], filters: [{ name: 'Streamglass capture session', extensions: ['sgsession'] }],
      });
      if (canceled || !filePaths.length) return null;
      return importSession({ ...bootstrap, source: filePaths[0] });
    }
    if (typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw new Error('Invalid session ID');
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      defaultPath: `streamglass-${input.sessionId}.sgsession`, filters: [{ name: 'Streamglass capture session', extensions: ['sgsession'] }],
    });
    if (canceled || !filePath) return null;
    await exportSession({ ...bootstrap, destination: filePath, sessionId: input.sessionId });
    return { saved: true };
  });
  handle('list-devices', async (_event, options) => {
    const service = await deviceServiceForCurrentPort();
    const status = await (options?.networkOnly === true ? service.monitorStatus() : service.list());
    return { ...status, monitorRestoreError: status.monitorError ?? monitorRestoreError };
  });
  handle('device-action', async (event, input) => {
    if (checkingQuit) throw new Error('Streamglass is preparing to quit. Try again after keeping the app open.');
    const descriptions = {
      'mac-trust-ca': 'Trust the Streamglass CA for this Mac user in the login keychain',
      'simulator-prepare': 'Prepare simulator capture: trust the CA for this Mac user, install the simulator CA, and enable Mac monitoring',
      'simulator-certificates': 'Trust the CA for this Mac user and install it in the selected simulator without changing network proxy settings',
      'simulator-install-ca': 'Install the Streamglass CA in the selected simulator',
      'android-install-ca': 'Copy the public CA to the selected Android device and open Settings',
      'android-enable-proxy': 'Route the selected Android device through Streamglass',
      'android-restore-proxy': 'Restore the selected Android device’s saved proxy settings',
      'mac-enable-proxy': 'Enable Mac monitoring on the active network, following connection changes automatically',
      'mac-restore-proxy': 'Disable Mac monitoring and restore every saved network proxy',
    };
    if (!input || !Object.hasOwn(descriptions, input.action)) throw new Error('Unknown setup action');
    if (input.action === 'android-enable-proxy') {
      const response = await fetch(`${bootstrap.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Cannot read proxy settings');
      const { settings } = await response.json();
      if (!settings.proxyEnabled || settings.listenHost !== '0.0.0.0' || !bootstrap.lanAddresses.length) throw new Error('Start the proxy and enable LAN access in Settings before configuring Android.');
    }
    const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
      message: descriptions[input.action], detail: `${input.target || 'This Mac'}${input.networkTarget ? ` · ${input.networkTarget}` : ''}. Certificate trust may request your login credentials. System proxy changes require permission; a standard account will be directed to IT or app-specific proxy setup without an administrator prompt. Mac monitoring is remembered across restarts; capture pause is unchanged.`,
    });
    if (confirmation.response !== 1) return { message: 'Cancelled' };
    if (checkingQuit) throw new Error('Streamglass is preparing to quit. Try again after keeping the app open.');
    const service = await deviceServiceForCurrentPort();
    if (checkingQuit) throw new Error('Streamglass is preparing to quit. Try again after keeping the app open.');
    const result = await service.perform(input);
    monitorRestoreError = '';
    return result;
  });
  handle('open-external', async (_event, value) => {
    const url = new URL(value);
    const allowed = ['docs.mitmproxy.org', 'developer.apple.com', 'support.apple.com', 'developer.android.com'];
    if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password) throw new Error('External link is not permitted');
    await shell.openExternal(url.href);
  });
  const checkForUpdate = createUpdateChecker({ currentVersion: app.getVersion() });
  handle('update-status', async (_event, force) => (app.isPackaged && process.env.STREAMGLASS_DISABLE_UPDATE_CHECK !== '1' ? checkForUpdate({ force: force === true }) : null));
  handle('about-info', () => ({ version: app.getVersion(), electron: process.versions.electron, links: Object.keys(aboutLinks) }));
  handle('open-about-link', async (_event, key) => {
    if (!Object.hasOwn(aboutLinks, key)) throw new Error('Unknown link');
    await shell.openExternal(aboutLinks[key]);
  });
  handle('open-update', async (_event, value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.href.startsWith(releasesPrefix) || url.username || url.password) throw new Error('Update link is not permitted');
    await shell.openExternal(url.href);
  });
  startupReady = true;
  createWindow();
  void pollPendingEditors();
}

app.on('second-instance', () => { const win = [...windows][0]; if (win) { win.restore(); win.focus(); } });
app.on('activate', () => { if (startupReady && !windows.size && !shuttingDown) createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault();
  if (checkingQuit) return;
  checkingQuit = true;
  void (async () => {
    let cleanup = {remainingProxyTargets:[], errors:[]};
    try { if (devices) cleanup = await devices.service.prepareQuit(); }
    catch (error) { cleanup.errors = [error.message]; }
    if (cleanup.remainingProxyTargets.length || cleanup.errors.length) {
      const macProblem = cleanup.errors.length || cleanup.remainingProxyTargets.some(target => target.startsWith('mac:'));
      const result = await dialog.showMessageBox({ type: 'warning', buttons: ['Keep Open', 'Quit Anyway'], defaultId: 0, cancelId: 0,
        message: macProblem ? 'Mac proxy settings could not be fully restored' : 'Some devices still use this proxy',
        detail: [macProblem ? 'Your Mac may still point to Streamglass. Keep the app open and restore its proxy in Device Setup or macOS Network settings.' : 'Mac proxy settings were restored. Other configured devices may still use Streamglass; restore their proxy in Device Setup or on the device before quitting.', ...cleanup.errors].join('\n') });
      if (result.response !== 1) {
        checkingQuit = false;
        // The device service exposes any resume failure through monitorError.
        await devices?.service.restoreMonitor({startListener:false}).catch(() => {});
        if (!windows.size) createWindow();
        return;
      }
    }
    shuttingDown = true;
    clearTimeout(pendingTimer);
    await mcpService?.close();
    scriptService?.close();
    if (engine && engine.exitCode === null) {
      engine.kill('SIGTERM');
      await Promise.race([new Promise(resolve => engine.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (engine.exitCode === null) engine.kill('SIGKILL');
    }
    app.quit();
  })();
});
start().catch(error => { dialog.showErrorBox('Streamglass could not start', error.message); app.quit(); });

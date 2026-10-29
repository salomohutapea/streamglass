// Renderer state contains capabilities only; traffic and credentials never enter the menu.
const flags = ['ready', 'busy', 'modal', 'selected', 'inspectable', 'hasResponse', 'hasEvents', 'hasRecords', 'hasDeviceRecords', 'capturePaused', 'proxyRunning'];
const enums = { theme: ['light', 'dark'], kind: ['all', 'sse'], tab: ['overview', 'request', 'response', 'events', 'console'] };

export function validateMenuState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== flags.length + Object.keys(enums).length ||
      flags.some(key => typeof input[key] !== 'boolean') ||
      Object.entries(enums).some(([key, values]) => !values.includes(input[key]))) throw new Error('Invalid menu state');
  return Object.fromEntries([...flags, ...Object.keys(enums)].map(key => [key, input[key]]));
}

export function createApplicationMenu({ app, Menu, BrowserWindow, windows, getToolsOwner, openAbout, zoom }) {
  const states = new WeakMap(), detachedWindows = new WeakSet(), editorWindows = new WeakSet(), toolsWindows = new WeakSet();
  const isToolCommand = id => id === 'map-local' || id === 'map-remote' || id === 'rewrite-rules' || id === 'block-rules' || id === 'network-profile' || id.startsWith('lab-') || id.startsWith('daily-');
  const focused = () => {
    const win = BrowserWindow.getFocusedWindow();
    return win && windows.has(win) && !win.isDestroyed() ? win : null;
  };
  const command = (id, label, accelerator, type) => ({
    id, label, ...(accelerator ? { accelerator } : {}), ...(type ? { type } : {}), enabled: false,
    click: () => {
      const win = focused();
      if (win && menu.getMenuItemById(id)?.enabled) {
        const target = toolsWindows.has(win) && !isToolCommand(id) ? getToolsOwner?.() ?? win : win;
        target.webContents.send('menu-action', id);
        if (target !== win) {target.restore(); target.focus();}
      }
      sync();
    },
  });
  const platforms = [['macos', 'This Mac'], ['ios-simulator', 'iOS Simulator'], ['ios-device', 'iOS Device'], ['android-emulator', 'Android Emulator'], ['android-device', 'Android Device']];
  const setupCommands = platforms.map(([platform, label]) => ({ ...command(`setup-${platform}`, `${label}…`), click: () => {
    const win = focused();
    if (win && menu.getMenuItemById(`setup-${platform}`)?.enabled) {
      const target = toolsWindows.has(win) ? getToolsOwner?.() ?? win : win;
      target.webContents.send('menu-action', 'open-device-setup', { platform });
      if (target !== win) {target.restore(); target.focus();}
    }
  } }));
  const separator = { type: 'separator' };
  const menu = Menu.buildFromTemplate([
    { label: 'Streamglass', submenu: [
      { label: 'About Streamglass', click: () => openAbout?.() }, separator,
      command('settings', 'Settings…', 'CmdOrCtrl+,'), separator,
      { role: 'services' }, separator,
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      command('connect-device', 'Connect Device…', 'CmdOrCtrl+Shift+D'), separator,
      command('daily-sessions', 'Saved Capture Sessions…', 'CmdOrCtrl+Shift+S'), separator,
      { label: 'Export Selected', submenu: [
        command('export-curl', 'cURL…'), command('export-request', 'Request…'),
        command('export-response', 'Response…'), command('export-events', 'SSE Events…'),
      ] }, command('export-all', 'Export All Captures…'), separator, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, separator,
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'Capture', submenu: [
      command('capture-toggle', 'Pause Capture and Rules', 'CmdOrCtrl+Shift+P'),
      command('proxy-toggle', 'Stop Proxy', 'CmdOrCtrl+Shift+K'), separator,
      command('clear-selected', 'Delete Selected Request'),
      command('clear-device', 'Clear Selected Device’s Requests…'),
      command('clear-all', 'Clear All Requests…'),
    ] },
    { label: 'Inspect', submenu: [
      command('inspect-overview', 'Overview', 'CmdOrCtrl+1', 'checkbox'),
      command('inspect-request', 'Request', 'CmdOrCtrl+2', 'checkbox'),
      command('inspect-response', 'Response', 'CmdOrCtrl+3', 'checkbox'),
      command('inspect-events', 'SSE Events', 'CmdOrCtrl+4', 'checkbox'),
      command('inspect-console', 'Script Console', 'CmdOrCtrl+5', 'checkbox'), separator,
      command('detach-inspector', 'Detach Inspector', 'CmdOrCtrl+Shift+I'),
    ] },
    { label: 'Rules', submenu: [
      command('breakpoints', 'Breakpoint Rules…'), command('breakpoint-new', 'New Breakpoint from Selected Request…'), separator,
      command('scripts', 'JavaScript Rules…'), command('script-new', 'New JavaScript Rule from Selected Request…'),
    ] },
    { label: 'Tools', submenu: [
      command('map-local', 'Map Local…'), command('map-remote', 'Map Remote…'), command('rewrite-rules', 'Rewrite…'), command('block-rules', 'Block…'), command('network-profile', 'Network Conditioner…'), separator,
      command('daily-journeys', 'Search Journeys…'), command('daily-fields', 'Custom Fields…'),
      command('daily-assertions', 'Capture Assertions…'), command('daily-repeat', 'Repeated Replay…'),
      command('daily-views', 'Saved Filters…'), command('daily-notes', 'Notes and Highlights…'), separator,
      command('lab-compare', 'Compare Captures…'), command('lab-replay', 'Edit and Resend…'),
      command('lab-scenarios', 'Test Scenarios…'), command('lab-fixture', 'Save Capture as Mock…'),
      command('lab-share', 'Redacted Export…'), separator,
      command('lab-workspaces', 'Configuration Workspaces…'), command('lab-codecs', 'Body Codecs…'), command('lab-mcp', 'Agent (MCP) Setup…'),
    ] },
    { label: 'Certificate / Setup', submenu: setupCommands },
    { label: 'View', submenu: [
      command('inspector-right', 'Inspector on Right'), command('inspector-below', 'Inspector Below'), separator,
      command('view-all', 'All Requests', undefined, 'checkbox'), command('view-sse', 'SSE Requests', undefined, 'checkbox'), separator,
      command('focus-search', 'Find in Captured Traffic…', 'CmdOrCtrl+F'),
      command('command-palette', 'Command Palette…', 'CmdOrCtrl+K'), separator,
      command('theme-light', 'Light Appearance', undefined, 'checkbox'), command('theme-dark', 'Dark Appearance', undefined, 'checkbox'), separator,
      // ⌘= is the unshifted key for ⌘+ on most layouts, so both accelerators zoom in; the second item stays hidden.
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom?.('in') },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => zoom?.('in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom?.('out') },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom?.('reset') }, separator,
      { role: 'togglefullscreen' },
    ] },
    { role: 'help', submenu: [command('shortcut-sheet', 'Keyboard Shortcuts', 'CmdOrCtrl+/')] },
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, separator, { role: 'front' }] },
  ]);
  function sync() {
    const focusedWindow = focused();
    const win = focusedWindow && toolsWindows.has(focusedWindow) ? getToolsOwner?.() ?? focusedWindow : focusedWindow;
    const state = win && !editorWindows.has(win) && states.get(win);
    const active = !!state && !state.modal, ready = active && state.ready && !state.busy;
    const selected = ready && state.selected, inspectable = selected && state.inspectable;
    const library = active && !detachedWindows.has(win);
    const set = (id, enabled, checked, label) => {
      const item = menu.getMenuItemById(id);
      item.enabled = !!enabled;
      if (checked !== undefined) item.checked = checked;
      if (label) item.label = label;
    };
    for (const id of ['settings', 'connect-device', 'breakpoints', 'scripts', 'map-local', 'map-remote', 'rewrite-rules', 'block-rules', 'network-profile', ...platforms.map(([platform]) => `setup-${platform}`)]) set(id, ready);
    set('capture-toggle', ready, undefined, state?.proxyRunning === false ? 'Start Capture and Rules' : state?.capturePaused ? 'Resume Capture and Rules' : 'Pause Capture and Rules');
    set('proxy-toggle', ready, undefined, state?.proxyRunning === false ? 'Start Proxy' : 'Stop Proxy');
    set('clear-selected', selected);
    set('clear-device', ready && library && state.hasDeviceRecords);
    set('clear-all', ready && state.hasRecords);
    set('export-all', ready && state.hasRecords);
    for (const id of ['daily-sessions', 'daily-journeys', 'daily-fields', 'daily-assertions', 'daily-repeat', 'daily-views', 'daily-notes']) set(id, ready);
    for (const id of ['lab-replay', 'lab-scenarios', 'lab-workspaces', 'lab-codecs', 'lab-mcp']) set(id, ready);
    set('lab-compare', ready && state.hasRecords);
    set('lab-fixture', inspectable && state.hasResponse);
    set('lab-share', inspectable);
    set('export-curl', inspectable); set('export-request', inspectable);
    set('export-response', inspectable && state.hasResponse); set('export-events', inspectable && state.hasEvents);
    set('breakpoint-new', inspectable); set('script-new', inspectable);
    for (const tab of enums.tab) set(`inspect-${tab}`, tab === 'overview' ? selected : inspectable, state?.tab === tab);
    set('detach-inspector', selected && !detachedWindows.has(win));
    set('view-all', library, state?.kind === 'all'); set('view-sse', library, state?.kind === 'sse');
    set('focus-search', library);
    set('command-palette', ready); set('shortcut-sheet', ready);
    set('inspector-right', ready && library); set('inspector-below', ready && library);
    set('theme-light', active, state?.theme === 'light'); set('theme-dark', active, state?.theme === 'dark');
  }
  Menu.setApplicationMenu(menu);
  app.on('browser-window-focus', sync);
  app.on('browser-window-blur', () => setImmediate(sync));
  sync();
  return {
    register(win, detached, editor, tools) { if (detached) detachedWindows.add(win); if (editor) editorWindows.add(win); if (tools) toolsWindows.add(win); },
    updateState(win, input) { states.set(win, validateMenuState(input)); if (focused() === win || toolsWindows.has(focused()) && getToolsOwner?.() === win) sync(); },
    forget(win) { states.delete(win); sync(); },
  };
}

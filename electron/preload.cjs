const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('streamglass', Object.freeze({
  getWorkspaces: () => ipcRenderer.invoke('workspaces-list'),
  saveWorkspace: (input) => ipcRenderer.invoke('workspaces-save', input),
  loadWorkspace: (input) => ipcRenderer.invoke('workspaces-load', input),
  renameWorkspace: (input) => ipcRenderer.invoke('workspaces-rename', input),
  deleteWorkspace: (input) => ipcRenderer.invoke('workspaces-delete', input),
  getBootstrap: () => ipcRenderer.invoke('bootstrap'),
  getUiZoom: () => ipcRenderer.invoke('ui-zoom'),
  onUiZoom: (callback) => {
    const listener = (_event, factor) => callback(factor);
    ipcRenderer.on('ui-zoom-changed', listener);
    return () => ipcRenderer.removeListener('ui-zoom-changed', listener);
  },
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text'),
  getMcpConnection: () => ipcRenderer.invoke('mcp-connection'),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('mcp-enabled', enabled),
  rotateMcpToken: () => ipcRenderer.invoke('mcp-rotate-token'),
  forgetMcpRedirect: (target) => ipcRenderer.invoke('mcp-forget-redirect', target),
  getApprovals: () => ipcRenderer.invoke('approvals'),
  resolveApproval: (input) => ipcRenderer.invoke('resolve-approval', input),
  onApprovals: (callback) => {
    const listener = (_event, list) => callback(list);
    ipcRenderer.on('approvals-changed', listener);
    return () => ipcRenderer.removeListener('approvals-changed', listener);
  },
  detachInspector: (recordId) => ipcRenderer.invoke('detach-inspector', recordId),
  deviceNames: (addresses) => ipcRenderer.invoke('device-names', addresses),
  lanApprovalAttention: () => ipcRenderer.invoke('lan-approval-attention'),
  openEditor: (input) => ipcRenderer.invoke('open-editor', input),
  openTools: (input) => ipcRenderer.invoke('open-tools', input),
  openSettings: (input) => ipcRenderer.invoke('open-settings', input),
  openDeviceSetup: (input) => ipcRenderer.invoke('open-device-setup', input),
  showDeviceTraffic: (deviceId) => ipcRenderer.invoke('show-device-traffic', deviceId),
  getToolsContext: () => ipcRenderer.invoke('tools-context'),
  toolsAction: (input) => ipcRenderer.invoke('tools-action', input),
  pickMapLocalFile: () => ipcRenderer.invoke('pick-map-local-file'),
  exportFile: (file) => ipcRenderer.invoke('export-file', file),
  exportAllCaptures: () => ipcRenderer.invoke('export-all-captures'),
  sessionFile: (input) => ipcRenderer.invoke('session-file', input),
  listDevices: (options) => ipcRenderer.invoke('list-devices', options),
  setupSite: (input) => ipcRenderer.invoke('setup-site', input),
  deviceAction: (action) => ipcRenderer.invoke('device-action', action),
  deviceInventory: (input) => ipcRenderer.invoke('device-inventory', input),
  watchDevices: (input) => ipcRenderer.invoke('watch-devices', input),
  connectDevice: (input) => ipcRenderer.invoke('connect-device', input),
  disconnectDevice: (input) => ipcRenderer.invoke('disconnect-device', input),
  revertAllDevices: (input) => ipcRenderer.invoke('revert-all-devices', input),
  setDeviceOptions: (input) => ipcRenderer.invoke('set-device-options', input),
  confirmUserCert: (input) => ipcRenderer.invoke('confirm-user-cert', input),
  reopenCertInstaller: (input) => ipcRenderer.invoke('reopen-cert-installer', input),
  startAdbPairing: (input) => ipcRenderer.invoke('start-adb-pairing', input),
  cancelAdbPairing: (input) => ipcRenderer.invoke('cancel-adb-pairing', input),
  onDeviceInventory: (callback) => {
    const listener = (_event, inventory) => callback(inventory);
    ipcRenderer.on('device-inventory', listener);
    return () => ipcRenderer.removeListener('device-inventory', listener);
  },

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getUpdate: (force) => ipcRenderer.invoke('update-status', force),
  getAboutInfo: () => ipcRenderer.invoke('about-info'),
  openAboutLink: (key) => ipcRenderer.invoke('open-about-link', key),
  openUpdate: (url) => ipcRenderer.invoke('open-update', url),
  setMenuState: (state) => ipcRenderer.invoke('menu-state', state),
  onMenuAction: (callback) => {
    const listener = (_event, action, payload) => callback(action, payload);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
}));

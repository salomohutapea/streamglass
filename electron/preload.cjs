const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('streamglass', Object.freeze({
  getWorkspaces: () => ipcRenderer.invoke('workspaces-list'),
  saveWorkspace: (input) => ipcRenderer.invoke('workspaces-save', input),
  loadWorkspace: (input) => ipcRenderer.invoke('workspaces-load', input),
  renameWorkspace: (input) => ipcRenderer.invoke('workspaces-rename', input),
  deleteWorkspace: (input) => ipcRenderer.invoke('workspaces-delete', input),
  getBootstrap: () => ipcRenderer.invoke('bootstrap'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  getMcpConnection: () => ipcRenderer.invoke('mcp-connection'),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('mcp-enabled', enabled),
  detachInspector: (recordId) => ipcRenderer.invoke('detach-inspector', recordId),
  openEditor: (input) => ipcRenderer.invoke('open-editor', input),
  openTools: (input) => ipcRenderer.invoke('open-tools', input),
  getToolsContext: () => ipcRenderer.invoke('tools-context'),
  toolsAction: (input) => ipcRenderer.invoke('tools-action', input),
  pickMapLocalFile: () => ipcRenderer.invoke('pick-map-local-file'),
  exportFile: (file) => ipcRenderer.invoke('export-file', file),
  exportAllCaptures: () => ipcRenderer.invoke('export-all-captures'),
  sessionFile: (input) => ipcRenderer.invoke('session-file', input),
  listDevices: (options) => ipcRenderer.invoke('list-devices', options),
  deviceAction: (action) => ipcRenderer.invoke('device-action', action),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getUpdate: (force) => ipcRenderer.invoke('update-status', force),
  openUpdate: (url) => ipcRenderer.invoke('open-update', url),
  setMenuState: (state) => ipcRenderer.invoke('menu-state', state),
  onMenuAction: (callback) => {
    const listener = (_event, action, payload) => callback(action, payload);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
}));

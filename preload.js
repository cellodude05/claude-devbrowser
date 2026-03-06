const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Tab management (renderer → main)
  createTab: (url) => ipcRenderer.invoke('tab-create', url),
  closeTab: (tabId) => ipcRenderer.invoke('tab-close', tabId),
  switchTab: (tabId) => ipcRenderer.invoke('tab-switch', tabId),
  navigate: (tabId, url) => ipcRenderer.invoke('tab-navigate', tabId, url),
  goBack: (tabId) => ipcRenderer.invoke('tab-go-back', tabId),
  goForward: (tabId) => ipcRenderer.invoke('tab-go-forward', tabId),
  listTabs: () => ipcRenderer.invoke('tab-list'),

  // Tab events (main → renderer)
  onTabCreated: (cb) => ipcRenderer.on('tab-created', (e, tab) => cb(tab)),
  onTabClosed: (cb) => ipcRenderer.on('tab-closed', (e, tabId) => cb(tabId)),
  onTabUpdated: (cb) => ipcRenderer.on('tab-updated', (e, tab) => cb(tab)),
  onTabSwitched: (cb) => ipcRenderer.on('tab-switched', (e, tabId) => cb(tabId)),

  // Webview commands (main → renderer, for MCP)
  onNavigateWebview: (cb) => ipcRenderer.on('tab-navigate-webview', (e, tabId, url) => cb(tabId, url)),
  onGoBackWebview: (cb) => ipcRenderer.on('tab-go-back-webview', (e, tabId) => cb(tabId)),
  onGoForwardWebview: (cb) => ipcRenderer.on('tab-go-forward-webview', (e, tabId) => cb(tabId)),
  onExecInWebview: (cb) => ipcRenderer.on('exec-in-webview', (e, requestId, tabId, code) => cb(requestId, tabId, code)),
  onScreenshotWebview: (cb) => ipcRenderer.on('screenshot-webview', (e, requestId, tabId, maxWidth, quality) => cb(requestId, tabId, maxWidth, quality)),

  // Wait-for-load (main → renderer)
  onWaitForLoad: (cb) => ipcRenderer.on('wait-for-load', (e, requestId, tabId) => cb(requestId, tabId)),

  // Response channels (renderer → main)
  sendExecResult: (requestId, result) => ipcRenderer.send('exec-result', requestId, result),
  sendScreenshotResult: (requestId, result) => ipcRenderer.send('screenshot-result', requestId, result),
  sendLoadResult: (requestId, result) => ipcRenderer.send('load-result', requestId, result),
  sendConsoleMessage: (tabId, entry) => ipcRenderer.send('console-message', tabId, entry),

  rendererReady: () => ipcRenderer.send('renderer-ready'),
});

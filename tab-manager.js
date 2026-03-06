const { ipcMain } = require('electron');

let nextTabId = 1;
let nextRequestId = 1;

class TabManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tabs = new Map();
    this.activeTabId = null;
    this.pendingExec = new Map();
    this.pendingScreenshot = new Map();

    // Listen for results from renderer
    ipcMain.on('exec-result', (e, requestId, result) => {
      const p = this.pendingExec.get(requestId);
      if (p) {
        this.pendingExec.delete(requestId);
        clearTimeout(p.timeout);
        if (result.error) p.reject(new Error(result.error));
        else p.resolve(result.value);
      }
    });

    ipcMain.on('screenshot-result', (e, requestId, result) => {
      const p = this.pendingScreenshot.get(requestId);
      if (p) {
        this.pendingScreenshot.delete(requestId);
        clearTimeout(p.timeout);
        if (result.error) p.reject(new Error(result.error));
        else p.resolve(result.dataUrl);
      }
    });
  }

  createTab(url = 'about:blank') {
    const tabId = `tab-${nextTabId++}`;
    const tab = { id: tabId, url, title: 'New Tab', loading: false };
    this.tabs.set(tabId, tab);

    this.mainWindow.webContents.send('tab-created', tab);

    if (url && url !== 'about:blank') {
      this.mainWindow.webContents.send('tab-navigate-webview', tabId, url);
    }

    this.switchTab(tabId);
    return tab;
  }

  closeTab(tabId) {
    if (!this.tabs.has(tabId)) return { success: false, error: 'Tab not found' };

    this.tabs.delete(tabId);
    this.mainWindow.webContents.send('tab-closed', tabId);

    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        this.createTab();
      }
    }

    return { success: true };
  }

  switchTab(tabId) {
    if (!this.tabs.has(tabId)) return { success: false, error: 'Tab not found' };

    this.activeTabId = tabId;
    this.mainWindow.webContents.send('tab-switched', tabId);
    return { success: true };
  }

  navigate(tabId, url) {
    const id = tabId || this.activeTabId;
    if (!id || !this.tabs.has(id)) return { success: false, error: 'Tab not found' };

    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      url = 'https://' + url;
    }

    const tab = this.tabs.get(id);
    tab.url = url;
    this.mainWindow.webContents.send('tab-navigate-webview', id, url);
    return { success: true, tabId: id, url };
  }

  goBack(tabId) {
    const id = tabId || this.activeTabId;
    if (!id) return { success: false, error: 'No active tab' };
    this.mainWindow.webContents.send('tab-go-back-webview', id);
    return { success: true };
  }

  goForward(tabId) {
    const id = tabId || this.activeTabId;
    if (!id) return { success: false, error: 'No active tab' };
    this.mainWindow.webContents.send('tab-go-forward-webview', id);
    return { success: true };
  }

  updateTabInfo(tabId, info) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    if (info.url) tab.url = info.url;
    if (info.title) tab.title = info.title;
    if (info.loading !== undefined) tab.loading = info.loading;

    this.mainWindow.webContents.send('tab-updated', tab);
  }

  listTabs() {
    return Array.from(this.tabs.values()).map(tab => ({
      ...tab,
      active: tab.id === this.activeTabId,
    }));
  }

  getActiveTab() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : null;
  }

  getActiveTabId() {
    return this.activeTabId;
  }

  async executeInTab(tabId, code) {
    const id = tabId || this.activeTabId;
    if (!id || !this.tabs.has(id)) throw new Error('Tab not found');

    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++;

      const timeout = setTimeout(() => {
        this.pendingExec.delete(requestId);
        reject(new Error('Execution timed out'));
      }, 30000);

      this.pendingExec.set(requestId, { resolve, reject, timeout });
      this.mainWindow.webContents.send('exec-in-webview', requestId, id, code);
    });
  }

  async screenshotTab(tabId, maxWidth = 800, quality = 'jpeg') {
    const id = tabId || this.activeTabId;
    if (!id || !this.tabs.has(id)) throw new Error('Tab not found');

    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++;

      const timeout = setTimeout(() => {
        this.pendingScreenshot.delete(requestId);
        reject(new Error('Screenshot timed out'));
      }, 15000);

      this.pendingScreenshot.set(requestId, { resolve, reject, timeout });
      this.mainWindow.webContents.send('screenshot-webview', requestId, id, maxWidth, quality);
    });
  }
}

module.exports = { TabManager };

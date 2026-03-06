const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { createWSServer, stopWSServer } = require('./ws-server');
const { TabManager } = require('./tab-manager');

let mainWindow;
let tabManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 12 },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Intercept new windows from webviews - open as new tabs instead
  mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
    webContents.setWindowOpenHandler(({ url }) => {
      // Navigate in the current active tab instead of opening a new tab
      if (tabManager) {
        tabManager.navigate(null, url);
      }
      return { action: 'deny' };
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Wait for renderer to signal ready
  ipcMain.once('renderer-ready', () => {
    tabManager = new TabManager(mainWindow);
    createWSServer(tabManager);
  });

  // IPC handlers for renderer
  ipcMain.handle('tab-navigate', (e, tabId, url) => tabManager.navigate(tabId, url));
  ipcMain.handle('tab-create', (e, url) => tabManager.createTab(url));
  ipcMain.handle('tab-close', (e, tabId) => tabManager.closeTab(tabId));
  ipcMain.handle('tab-switch', (e, tabId) => tabManager.switchTab(tabId));
  ipcMain.handle('tab-go-back', (e, tabId) => tabManager.goBack(tabId));
  ipcMain.handle('tab-go-forward', (e, tabId) => tabManager.goForward(tabId));
  ipcMain.handle('tab-list', () => tabManager.listTabs());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWSServer();
  app.quit();
});

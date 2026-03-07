const tabsContainer = document.getElementById('tabs-container');
const webviewContainer = document.getElementById('webview-container');
const urlBar = document.getElementById('url-bar');
const newTabBtn = document.getElementById('new-tab-btn');
const backBtn = document.getElementById('back-btn');
const forwardBtn = document.getElementById('forward-btn');
const reloadBtn = document.getElementById('reload-btn');

const tabs = new Map(); // tabId -> { element, webview }
let activeTabId = null;

// Tab creation from main process
window.api.onTabCreated((tab) => {
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = tab.id;

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tab.title || 'New Tab';

  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.closeTab(tab.id);
  });

  tabEl.appendChild(titleEl);
  tabEl.appendChild(closeEl);
  tabEl.addEventListener('click', () => window.api.switchTab(tab.id));
  tabsContainer.appendChild(tabEl);

  // Create webview
  const webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('partition', 'persist:devbrowser');
  webview.src = tab.url || 'about:blank';
  webviewContainer.appendChild(webview);

  // Intercept new window requests (target="_blank" links, window.open, etc.)
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    window.api.navigate(tab.id, e.url);
  });

  // Capture console messages
  webview.addEventListener('console-message', (e) => {
    window.api.sendConsoleMessage(tab.id, {
      level: ['verbose', 'info', 'warning', 'error'][e.level] || 'info',
      message: e.message,
      line: e.line,
      source: e.sourceId,
      timestamp: Date.now(),
    });
  });

  // Webview events
  webview.addEventListener('did-start-loading', () => {
    updateTabLoading(tab.id, true);
  });

  webview.addEventListener('did-stop-loading', () => {
    updateTabLoading(tab.id, false);
  });

  webview.addEventListener('page-title-updated', (e) => {
    const t = tabs.get(tab.id);
    if (t) {
      t.element.querySelector('.tab-title').textContent = e.title;
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    if (tab.id === activeTabId) {
      urlBar.value = e.url;
    }
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame && tab.id === activeTabId) {
      urlBar.value = e.url;
    }
  });

  tabs.set(tab.id, { element: tabEl, webview });
});

// Tab closed
window.api.onTabClosed((tabId) => {
  const tab = tabs.get(tabId);
  if (tab) {
    tab.element.remove();
    tab.webview.remove();
    tabs.delete(tabId);
  }
});

// Tab switched
window.api.onTabSwitched((tabId) => {
  // Deactivate old
  if (activeTabId && tabs.has(activeTabId)) {
    const old = tabs.get(activeTabId);
    old.element.classList.remove('active');
    old.webview.classList.remove('active');
  }

  // Activate new
  activeTabId = tabId;
  const tab = tabs.get(tabId);
  if (tab) {
    tab.element.classList.add('active');
    tab.webview.classList.add('active');
    const url = tab.webview.getURL ? tab.webview.getURL() : '';
    urlBar.value = url || '';
    tab.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

// Tab updated
window.api.onTabUpdated((tabInfo) => {
  const tab = tabs.get(tabInfo.id);
  if (tab) {
    tab.element.querySelector('.tab-title').textContent = tabInfo.title || 'Loading...';
  }
});

// Commands from main process (for MCP)
window.api.onNavigateWebview((tabId, url) => {
  const tab = tabs.get(tabId);
  if (tab) tab.webview.loadURL(url);
});

window.api.onGoBackWebview((tabId) => {
  const tab = tabs.get(tabId);
  if (tab && tab.webview.canGoBack()) tab.webview.goBack();
});

window.api.onGoForwardWebview((tabId) => {
  const tab = tabs.get(tabId);
  if (tab && tab.webview.canGoForward()) tab.webview.goForward();
});

window.api.onExecInWebview(async (requestId, tabId, code) => {
  const tab = tabs.get(tabId);
  if (!tab) {
    window.api.sendExecResult(requestId, { error: 'Tab not found' });
    return;
  }
  try {
    const result = await tab.webview.executeJavaScript(code);
    window.api.sendExecResult(requestId, { value: result });
  } catch (err) {
    window.api.sendExecResult(requestId, { error: err.message });
  }
});

window.api.onScreenshotWebview(async (requestId, tabId, maxWidth, quality) => {
  const tab = tabs.get(tabId);
  if (!tab) {
    window.api.sendScreenshotResult(requestId, { error: 'Tab not found' });
    return;
  }
  try {
    const image = await tab.webview.capturePage();
    const size = image.getSize();
    const targetWidth = Math.min(maxWidth || 800, size.width);

    let resized = image;
    if (size.width > targetWidth) {
      resized = image.resize({ width: targetWidth });
    }

    // Always send PNG data URL from renderer - main process handles JPEG conversion
    const dataUrl = resized.toDataURL();
    window.api.sendScreenshotResult(requestId, { dataUrl });
  } catch (err) {
    window.api.sendScreenshotResult(requestId, { error: err.message });
  }
});

function updateTabLoading(tabId, loading) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const existing = tab.element.querySelector('.tab-loading');
  if (loading && !existing) {
    const spinner = document.createElement('div');
    spinner.className = 'tab-loading';
    tab.element.insertBefore(spinner, tab.element.firstChild);
  } else if (!loading && existing) {
    existing.remove();
  }
}

// URL bar navigation
urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    let url = urlBar.value.trim();
    if (!url) return;

    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      if (/^[\w.-]+\.\w{2,}/.test(url)) {
        url = 'https://' + url;
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }

    if (activeTabId) {
      window.api.navigate(activeTabId, url);
    }
    urlBar.blur();
  }
});

// Navigation buttons
backBtn.addEventListener('click', () => {
  if (activeTabId) window.api.goBack(activeTabId);
});

forwardBtn.addEventListener('click', () => {
  if (activeTabId) window.api.goForward(activeTabId);
});

reloadBtn.addEventListener('click', () => {
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) tab.webview.reload();
  }
});

newTabBtn.addEventListener('click', () => {
  window.api.createTab();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) {
    switch (e.key) {
      case 't':
        e.preventDefault();
        window.api.createTab();
        break;
      case 'w':
        e.preventDefault();
        if (activeTabId) window.api.closeTab(activeTabId);
        break;
      case 'l':
        e.preventDefault();
        urlBar.focus();
        urlBar.select();
        break;
      case 'r':
        e.preventDefault();
        if (activeTabId) {
          const tab = tabs.get(activeTabId);
          if (tab) tab.webview.reload();
        }
        break;
      case '[':
        e.preventDefault();
        if (activeTabId) window.api.goBack(activeTabId);
        break;
      case ']':
        e.preventDefault();
        if (activeTabId) window.api.goForward(activeTabId);
        break;
    }
  }
});

// Wait-for-load handler
window.api.onWaitForLoad((requestId, tabId) => {
  const tab = tabs.get(tabId);
  if (!tab) {
    window.api.sendLoadResult(requestId, { loaded: false, error: 'Tab not found' });
    return;
  }
  // Brief delay to let navigation initiate before checking isLoading
  setTimeout(() => {
    if (!tab.webview.isLoading()) {
      window.api.sendLoadResult(requestId, { loaded: true });
      return;
    }
    const handler = () => {
      tab.webview.removeEventListener('did-stop-loading', handler);
      window.api.sendLoadResult(requestId, { loaded: true });
    };
    tab.webview.addEventListener('did-stop-loading', handler);
  }, 200);
});

// Signal ready and create initial tab
window.api.rendererReady();
window.api.createTab('https://www.google.com');

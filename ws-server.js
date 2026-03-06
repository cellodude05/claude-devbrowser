const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DEVBROWSER_PORT || '19816', 10);
let wss = null;
let tabManager = null;

// Network request buffer (lazy-initialized)
const networkRequests = [];
const MAX_NETWORK_BUFFER = 500;
let networkCaptureActive = false;

function ensureNetworkCapture() {
  if (networkCaptureActive) return;
  networkCaptureActive = true;

  const { session } = require('electron');
  const ses = session.fromPartition('persist:devbrowser');

  ses.webRequest.onCompleted((details) => {
    networkRequests.push({
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      type: details.resourceType,
      fromCache: details.fromCache,
      timestamp: Date.now(),
    });
    if (networkRequests.length > MAX_NETWORK_BUFFER) {
      networkRequests.splice(0, networkRequests.length - MAX_NETWORK_BUFFER);
    }
  });

  ses.webRequest.onErrorOccurred((details) => {
    networkRequests.push({
      url: details.url,
      method: details.method,
      error: details.error,
      type: details.resourceType,
      timestamp: Date.now(),
    });
    if (networkRequests.length > MAX_NETWORK_BUFFER) {
      networkRequests.splice(0, networkRequests.length - MAX_NETWORK_BUFFER);
    }
  });
}

function createWSServer(tm) {
  tabManager = tm;
  wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

  wss.on('listening', () => {
    console.log(`DevBrowser WS server listening on 127.0.0.1:${PORT}`);
    // Start network capture once server is up
    ensureNetworkCapture();
  });

  wss.on('connection', (ws) => {
    console.log('MCP bridge connected');

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ id: null, error: 'Invalid JSON' }));
        return;
      }

      const { id, method, params } = msg;

      try {
        const result = await handleCommand(method, params || {});
        ws.send(JSON.stringify({ id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id, error: err.message }));
      }
    });

    ws.on('close', () => {
      console.log('MCP bridge disconnected');
    });
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use. Another DevBrowser instance may be running.`);
      const { app } = require('electron');
      app.quit();
      return;
    }
    console.error('WS server error:', err.message);
  });
}

function stopWSServer() {
  if (wss) {
    wss.close();
    wss = null;
  }
}

// Simple mime type lookup for file uploads
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.csv': 'text/csv', '.xml': 'text/xml',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[ext] || 'application/octet-stream';
}

async function handleCommand(method, params) {
  switch (method) {
    // ── Navigation ──────────────────────────────────────────────────────
    case 'navigate': {
      const { url, newTab, waitForLoad } = params;
      if (!url) throw new Error('url is required');
      let result;
      if (newTab) {
        const tab = tabManager.createTab(url);
        result = { tabId: tab.id, url };
      } else {
        result = tabManager.navigate(params.tabId, url);
      }
      if (waitForLoad !== false) {
        const id = result.tabId || params.tabId || tabManager.getActiveTabId();
        await tabManager.waitForTabLoad(id);
      }
      return result;
    }
    case 'go_back':
      return tabManager.goBack(params.tabId);
    case 'go_forward':
      return tabManager.goForward(params.tabId);

    // ── Content Reading ─────────────────────────────────────────────────
    case 'get_page_text': {
      const maxLength = params.maxLength || 50000;
      const code = `(() => {
        const main = document.querySelector('main, article, [role="main"], .main-content, #content, #main');
        const source = main || document.body;
        let text = source.innerText;
        if (text.length > ${maxLength}) {
          text = text.slice(0, ${maxLength}) + '\\n\\n[... truncated at ${maxLength} characters. Use maxLength parameter or scroll/find_text to see more.]';
        }
        return text;
      })()`;
      return { text: await tabManager.executeInTab(params.tabId, code) };
    }
    case 'get_page_html': {
      const selector = params.selector || 'html';
      const code = `(document.querySelector(${JSON.stringify(selector)}) || {}).outerHTML || ''`;
      return { html: await tabManager.executeInTab(params.tabId, code) };
    }
    case 'get_page_info': {
      const code = `JSON.stringify({ url: location.href, title: document.title })`;
      const raw = await tabManager.executeInTab(params.tabId, code);
      return JSON.parse(raw);
    }

    // ── Interaction ─────────────────────────────────────────────────────
    case 'click': {
      if (!params.selector) throw new Error('selector is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.click();
        return JSON.stringify({ success: true, tag: el.tagName, text: el.textContent.slice(0, 100) });
      })()`;
      const result = JSON.parse(await tabManager.executeInTab(params.tabId, code));
      if (result.success && params.waitForLoad) {
        await tabManager.waitForTabLoad(params.tabId);
      }
      return result;
    }
    case 'type': {
      if (!params.selector) throw new Error('selector is required');
      if (params.text === undefined) throw new Error('text is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.focus();
        if (${params.clear !== false}) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.value += ${JSON.stringify(params.text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ success: true });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'select': {
      if (!params.selector) throw new Error('selector is required');
      if (!params.value) throw new Error('value is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.value = ${JSON.stringify(params.value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ success: true });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'scroll': {
      const direction = params.direction || 'down';
      const amount = params.amount || 500;
      const delta = direction === 'up' ? -amount : amount;
      const code = `window.scrollBy(0, ${delta}); JSON.stringify({ scrollY: window.scrollY })`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'execute_js': {
      if (!params.code) throw new Error('code is required');
      const result = await tabManager.executeInTab(params.tabId, params.code);
      return { result };
    }
    case 'find_elements': {
      if (!params.selector) throw new Error('selector is required');
      const code = `(() => {
        const els = document.querySelectorAll(${JSON.stringify(params.selector)});
        return JSON.stringify(Array.from(els).slice(0, 50).map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          text: el.textContent.slice(0, 200).trim(),
          id: el.id || undefined,
          className: el.className || undefined,
          href: el.href || undefined,
          type: el.type || undefined,
          value: el.value || undefined,
        })));
      })()`;
      return { elements: JSON.parse(await tabManager.executeInTab(params.tabId, code)) };
    }
    case 'wait_for': {
      if (!params.selector) throw new Error('selector is required');
      const timeout = params.timeout || 10000;
      const code = `new Promise((resolve) => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (el) { resolve(JSON.stringify({ found: true })); return; }
        const observer = new MutationObserver(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (el) { observer.disconnect(); resolve(JSON.stringify({ found: true })); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(JSON.stringify({ found: false })); }, ${timeout});
      })`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }

    // ── Page Search & Navigation ────────────────────────────────────────
    case 'find_text': {
      if (!params.text) throw new Error('text is required');
      const searchText = JSON.stringify(params.text);
      const code = `(() => {
        const text = ${searchText}.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const matches = [];
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.toLowerCase().includes(text)) {
            const el = node.parentElement;
            const rect = el.getBoundingClientRect();
            matches.push({
              text: node.textContent.trim().slice(0, 300),
              tag: el.tagName.toLowerCase(),
              selector: el.id ? '#' + el.id : (el.className ? el.tagName.toLowerCase() + '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()),
              visible: rect.top >= 0 && rect.top <= window.innerHeight,
              y: rect.top + window.scrollY,
            });
          }
          if (matches.length >= 20) break;
        }
        return JSON.stringify({ found: matches.length, matches });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'scroll_to': {
      if (!params.selector) throw new Error('selector is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return JSON.stringify({ success: true, tag: el.tagName, text: el.textContent.slice(0, 100).trim() });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'get_section_text': {
      if (!params.selector) throw new Error('selector is required');
      const maxLength = params.maxLength || 10000;
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ error: 'Element not found' });
        let text = el.innerText;
        if (text.length > ${maxLength}) {
          text = text.slice(0, ${maxLength}) + '\\n[... truncated]';
        }
        return JSON.stringify({ text, tag: el.tagName.toLowerCase() });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }

    // ── Keyboard & Mouse ────────────────────────────────────────────────
    case 'press_key': {
      if (!params.key) throw new Error('key is required');
      const selectorCode = params.selector
        ? `document.querySelector(${JSON.stringify(params.selector)})`
        : 'document.activeElement';
      const code = `(() => {
        const el = ${selectorCode};
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        const opts = {
          key: ${JSON.stringify(params.key)},
          code: ${JSON.stringify(params.key)},
          bubbles: true,
          cancelable: true,
          shiftKey: ${!!params.shift},
          ctrlKey: ${!!params.ctrl},
          altKey: ${!!params.alt},
          metaKey: ${!!params.meta},
        };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        return JSON.stringify({ success: true });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }
    case 'hover': {
      if (!params.selector) throw new Error('selector is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return JSON.stringify({ success: true, tag: el.tagName, text: el.textContent.slice(0, 100).trim() });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }

    // ── iFrame Support ──────────────────────────────────────────────────
    case 'execute_in_frame': {
      if (!params.frameSelector) throw new Error('frameSelector is required');
      if (!params.code) throw new Error('code is required');
      const code = `(() => {
        const iframe = document.querySelector(${JSON.stringify(params.frameSelector)});
        if (!iframe) return JSON.stringify({ error: 'Frame not found' });
        try {
          const fn = new iframe.contentWindow.Function(${JSON.stringify('return ' + params.code)});
          const result = fn();
          return JSON.stringify({ result });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }

    // ── Console & Network ───────────────────────────────────────────────
    case 'read_console': {
      const logs = tabManager.getConsoleLogs(params.tabId, {
        level: params.level,
        pattern: params.pattern,
        clear: params.clear,
      });
      return { messages: logs, count: logs.length };
    }
    case 'read_network': {
      let filtered = [...networkRequests];
      if (params.urlPattern) {
        const re = new RegExp(params.urlPattern, 'i');
        filtered = filtered.filter(r => re.test(r.url));
      }
      if (params.type) {
        filtered = filtered.filter(r => r.type === params.type);
      }
      if (params.statusCode) {
        filtered = filtered.filter(r => r.statusCode === params.statusCode);
      }
      if (params.clear) {
        networkRequests.length = 0;
      }
      return { requests: filtered.slice(-100), count: filtered.length };
    }

    // ── Cookies ─────────────────────────────────────────────────────────
    case 'get_cookies': {
      const { session } = require('electron');
      const ses = session.fromPartition('persist:devbrowser');
      const filter = {};
      if (params.url) filter.url = params.url;
      if (params.domain) filter.domain = params.domain;
      const cookies = await ses.cookies.get(filter);
      return {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        })),
      };
    }

    // ── File Upload ─────────────────────────────────────────────────────
    case 'upload_file': {
      if (!params.selector) throw new Error('selector is required');
      if (!params.filePath) throw new Error('filePath is required');

      const filePath = params.filePath;
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

      const fileName = path.basename(filePath);
      const fileData = fs.readFileSync(filePath).toString('base64');
      const mimeType = getMimeType(fileName);

      const code = `(() => {
        const input = document.querySelector(${JSON.stringify(params.selector)});
        if (!input) return JSON.stringify({ success: false, error: 'Element not found' });
        try {
          const byteChars = atob(${JSON.stringify(fileData)});
          const byteArray = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
          const file = new File([byteArray], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return JSON.stringify({ success: true, fileName: ${JSON.stringify(fileName)} });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.message });
        }
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
    }

    // ── Page Snapshots ──────────────────────────────────────────────────
    case 'save_snapshot': {
      const os = require('os');
      const snapshotPath = params.filePath || path.join(os.tmpdir(), `devbrowser-snapshot-${Date.now()}.md`);

      const info = JSON.parse(await tabManager.executeInTab(params.tabId,
        'JSON.stringify({ url: location.href, title: document.title })'));
      const text = await tabManager.executeInTab(params.tabId, `(() => {
        const main = document.querySelector('main, article, [role="main"]');
        return (main || document.body).innerText;
      })()`);

      const content = `# ${info.title}\n\nURL: ${info.url}\nSaved: ${new Date().toISOString()}\n\n${text}`;
      fs.writeFileSync(snapshotPath, content, 'utf-8');
      return { success: true, filePath: snapshotPath, title: info.title, url: info.url };
    }

    // ── Screenshots ─────────────────────────────────────────────────────
    case 'screenshot': {
      const maxWidth = params.maxWidth || 800;
      const quality = params.quality || 'jpeg';
      const dataUrl = await tabManager.screenshotTab(params.tabId, maxWidth, quality);
      return { image: dataUrl };
    }

    // ── Tab Management ──────────────────────────────────────────────────
    case 'list_tabs':
      return { tabs: tabManager.listTabs() };
    case 'new_tab': {
      const tab = tabManager.createTab(params.url);
      return { tabId: tab.id, url: tab.url };
    }
    case 'switch_tab': {
      if (!params.tabId) throw new Error('tabId is required');
      return tabManager.switchTab(params.tabId);
    }
    case 'close_tab':
      return tabManager.closeTab(params.tabId || tabManager.getActiveTabId());

    // ── App Lifecycle ───────────────────────────────────────────────────
    case 'quit': {
      const { app } = require('electron');
      setTimeout(() => app.quit(), 100);
      return { success: true, message: 'DevBrowser shutting down' };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

module.exports = { createWSServer, stopWSServer };

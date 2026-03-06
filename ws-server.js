const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.DEVBROWSER_PORT || '19816', 10);
let wss = null;
let tabManager = null;

function createWSServer(tm) {
  tabManager = tm;
  wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

  wss.on('listening', () => {
    console.log(`DevBrowser WS server listening on 127.0.0.1:${PORT}`);
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
    console.error('WS server error:', err.message);
  });
}

function stopWSServer() {
  if (wss) {
    wss.close();
    wss = null;
  }
}

async function handleCommand(method, params) {
  switch (method) {
    // Navigation
    case 'navigate': {
      const { url, newTab } = params;
      if (!url) throw new Error('url is required');
      if (newTab) {
        const tab = tabManager.createTab(url);
        return { tabId: tab.id, url };
      }
      return tabManager.navigate(params.tabId, url);
    }
    case 'go_back':
      return tabManager.goBack(params.tabId);
    case 'go_forward':
      return tabManager.goForward(params.tabId);

    // Content reading
    case 'get_page_text': {
      const maxLength = params.maxLength || 50000;
      const code = `(() => {
        // Try to extract main content area first
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

    // Interaction
    case 'click': {
      if (!params.selector) throw new Error('selector is required');
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return JSON.stringify({ success: false, error: 'Element not found' });
        el.click();
        return JSON.stringify({ success: true, tag: el.tagName, text: el.textContent.slice(0, 100) });
      })()`;
      return JSON.parse(await tabManager.executeInTab(params.tabId, code));
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

    // Find text on page
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

    // Scroll to element
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

    // Get text from specific section
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

    // Screenshots
    case 'screenshot': {
      const maxWidth = params.maxWidth || 800;
      const quality = params.quality || 'jpeg';
      const dataUrl = await tabManager.screenshotTab(params.tabId, maxWidth, quality);
      return { image: dataUrl };
    }

    // Tab management
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

    // App lifecycle
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

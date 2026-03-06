#!/usr/bin/env node

// Thin MCP stdio server that bridges Claude Code ↔ Electron DevBrowser via WebSocket.
// Claude Code launches this process; it connects to the running Electron app's WS server.

const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.DEVBROWSER_PORT || '19816', 10);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_DIR = path.dirname(__filename);

let ws = null;
let requestId = 0;
const pending = new Map();
let electronProcess = null;

// MCP tool definitions
const TOOLS = [
  {
    name: 'devbrowser_navigate',
    description: 'Navigate to a URL in the browser. Use newTab to open in a new tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        newTab: { type: 'boolean', description: 'Open in a new tab', default: false },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'devbrowser_go_back',
    description: 'Go back in browser history.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_go_forward',
    description: 'Go forward in browser history.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_get_page_text',
    description: 'Get the visible text content of the current page. Tries to extract main content area first.',
    inputSchema: {
      type: 'object',
      properties: {
        maxLength: { type: 'number', description: 'Max characters to return (default: 50000)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_get_page_html',
    description: 'Get HTML content. Use selector to get a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (defaults to html)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_get_page_info',
    description: 'Get current page URL, title, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_click',
    description: 'Click an element matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'devbrowser_type',
    description: 'Type text into an input element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input element' },
        text: { type: 'string', description: 'Text to type' },
        clear: { type: 'boolean', description: 'Clear existing text first', default: true },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'devbrowser_select',
    description: 'Select an option in a dropdown/select element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of select element' },
        value: { type: 'string', description: 'Value to select' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'devbrowser_scroll',
    description: 'Scroll the page up or down.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'devbrowser_execute_js',
    description: 'Execute arbitrary JavaScript in the page context. Returns the result.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'devbrowser_find_elements',
    description: 'Find all elements matching a CSS selector. Returns tag, text, attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'devbrowser_wait_for',
    description: 'Wait for an element matching a CSS selector to appear.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'devbrowser_screenshot',
    description: 'Take a screenshot of the current page. Returns compressed base64 image.',
    inputSchema: {
      type: 'object',
      properties: {
        maxWidth: { type: 'number', description: 'Max image width in pixels (default: 800)' },
        quality: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format (default: jpeg, smaller)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_find_text',
    description: 'Search for text on the page. Returns matching elements with their positions and visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to search for (case-insensitive)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'devbrowser_scroll_to',
    description: 'Scroll to a specific element on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to scroll to' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'devbrowser_get_section_text',
    description: 'Get text content from a specific page section identified by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the section' },
        maxLength: { type: 'number', description: 'Max characters to return (default: 10000)' },
        tabId: { type: 'string', description: 'Target tab ID (defaults to active tab)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'devbrowser_list_tabs',
    description: 'List all open browser tabs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'devbrowser_new_tab',
    description: 'Open a new browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (defaults to about:blank)' },
      },
    },
  },
  {
    name: 'devbrowser_switch_tab',
    description: 'Switch to a specific browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to switch to' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'devbrowser_close_tab',
    description: 'Close a browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to close (defaults to active tab)' },
      },
    },
  },
  {
    name: 'devbrowser_quit',
    description: 'Quit the DevBrowser app. Use when done with browser tasks to free resources.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Map MCP tool names to WS commands
function toolToCommand(toolName) {
  return toolName.replace('devbrowser_', '');
}

// Launch the Electron app if not already running
function launchElectron() {
  if (electronProcess) return; // Already launched by us

  process.stderr.write('Launching DevBrowser app...\n');
  const electronBin = path.join(PROJECT_DIR, 'node_modules', '.bin', 'electron');
  electronProcess = spawn(electronBin, [PROJECT_DIR], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DEVBROWSER_PORT: String(PORT) },
  });

  electronProcess.unref(); // Let it survive if MCP server exits

  electronProcess.on('exit', () => {
    electronProcess = null;
  });
}

// Wait for the WebSocket to become available after launching
async function waitForConnection(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const connected = await connectToElectron();
    if (connected) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Ensure we're connected, launching if needed
async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;

  // Try connecting first (maybe app is already running)
  const connected = await connectToElectron();
  if (connected) return true;

  // Launch and wait
  launchElectron();
  return await waitForConnection();
}

// Send command to Electron via WebSocket
async function sendToElectron(method, params) {
  // Auto-launch if not connected
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const ok = await ensureConnected();
    if (!ok) {
      throw new Error('Could not connect to DevBrowser. Failed to auto-launch. Try running manually: npm start (in the claude-devbrowser directory)');
    }
  }

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Request timed out'));
    }, 30000);

    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Connect to Electron's WebSocket server
function connectToElectron() {
  return new Promise((resolve) => {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      process.stderr.write('Connected to DevBrowser\n');
      resolve(true);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timeout);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      } catch {}
    });

    ws.on('close', () => {
      process.stderr.write('Disconnected from DevBrowser\n');
      ws = null;
    });

    ws.on('error', () => {
      ws = null;
      resolve(false);
    });
  });
}

// MCP protocol handling over stdio
let inputBuffer = '';

function sendMCPResponse(response) {
  const json = JSON.stringify(response);
  process.stdout.write(`${json}\n`);
}

function handleMCPRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendMCPResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'devbrowser',
            version: '1.0.0',
          },
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendMCPResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;

    case 'tools/call': {
      const toolName = params.name;
      const toolParams = params.arguments || {};
      const command = toolToCommand(toolName);

      sendToElectron(command, toolParams)
        .then((result) => {
          // Return screenshots as image content
          if (command === 'screenshot' && result && result.image) {
            const match = result.image.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (match) {
              sendMCPResponse({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [
                    {
                      type: 'image',
                      data: match[2],
                      mimeType: match[1],
                    },
                  ],
                },
              });
              return;
            }
          }
          sendMCPResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                },
              ],
            },
          });
        })
        .catch((err) => {
          sendMCPResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            },
          });
        });
      break;
    }

    default:
      sendMCPResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
  }
}

// Main
async function main() {
  // Just try to connect if the app happens to be running already (don't launch)
  await connectToElectron();

  // Read MCP messages from stdin
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
    const lines = inputBuffer.split('\n');
    inputBuffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        handleMCPRequest(request);
      } catch {
        process.stderr.write(`Failed to parse MCP message: ${line}\n`);
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  // Periodically try to reconnect if disconnected
  setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      await connectToElectron();
    }
  }, 5000);
}

main();

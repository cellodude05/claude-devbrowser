# Claude DevBrowser

An Electron-based GUI browser that Claude Code CLI controls via MCP (Model Context Protocol). Designed for research and documentation browsing where you need to stay logged in to authenticated sites.

## Why This Exists

Claude Code's existing browser MCPs (Playwright, Chrome extension) are flaky and don't handle authenticated sessions well. This app gives you a **visible browser window** where you can log in to sites like Ellucian, and then Claude Code can read and interact with those authenticated pages.

## Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────┐
│  Claude Code CLI                │     │  Electron App (GUI)  │
│  ┌───────────────────────────┐  │     │  ┌────────────────┐  │
│  │ MCP Client                │  │     │  │ BrowserWindow   │  │
│  │ (built-in)               │  │     │  │ (tabbed views)  │  │
│  └─────────┬─────────────────┘  │     │  └────────────────┘  │
│            │ stdio               │     │  ┌────────────────┐  │
│  ┌─────────▼─────────────────┐  │     │  │ WebSocket       │  │
│  │ mcp-server.js             │◄─┼─ws──┼─►│ Server (:19816) │  │
│  │ (thin stdio↔ws bridge)    │  │     │  └────────────────┘  │
│  └───────────────────────────┘  │     └──────────────────────┘
└─────────────────────────────────┘
```

1. **Electron App** - A real browser with tabs. You launch it, log into your sites, browse normally.
2. **WebSocket Server** (port 19816) - Runs inside the Electron app, accepts commands.
3. **MCP Server** (`mcp-server.js`) - A thin stdio bridge that Claude Code launches. Translates MCP tool calls into WebSocket commands to the Electron app.

## Setup

### Install

```bash
cd /Users/ksried/dev/utilities/claude-devbrowser
npm install
```

### Add MCP Server to Claude Code (Global)

This makes the `devbrowser_*` tools available in **every** Claude Code session:

```bash
claude mcp add --scope user devbrowser -- node /Users/ksried/dev/utilities/claude-devbrowser/mcp-server.js
```

To remove it later:

```bash
claude mcp remove --scope user devbrowser
```

### Add MCP Server to a Single Project

Drop this in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "devbrowser": {
      "command": "node",
      "args": ["/Users/ksried/dev/utilities/claude-devbrowser/mcp-server.js"]
    }
  }
}
```

## Usage

### 1. Launch the Browser

```bash
cd /Users/ksried/dev/utilities/claude-devbrowser
npm start
```

The browser window opens with a tab bar, address bar, and a Google homepage. Log in to any sites you need. Links that would normally open in a new window (target="_blank") will navigate in the current tab instead.

### 2. Use from Claude Code

The browser will auto-launch when Claude Code first uses a devbrowser tool. You can also launch it manually with `npm start` if you want to log in to sites beforehand.

Ask Claude something like:
> "Use the devbrowser to go to the Ellucian documentation and find the API reference for Colleague Web API"

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘T | New tab |
| ⌘W | Close tab |
| ⌘L | Focus address bar |
| ⌘R | Reload |
| ⌘[ | Back |
| ⌘] | Forward |

## MCP Tools Reference

### Navigation
| Tool | Description |
|------|-------------|
| `devbrowser_navigate` | Go to a URL. Pass `newTab: true` to open in a new tab. |
| `devbrowser_go_back` | Browser back button |
| `devbrowser_go_forward` | Browser forward button |

### Reading Content
| Tool | Description |
|------|-------------|
| `devbrowser_get_page_text` | Get visible text (smart extraction from main content area). Pass `maxLength` to control size. |
| `devbrowser_get_page_html` | Get HTML (optionally filtered by CSS `selector`) |
| `devbrowser_get_page_info` | Get current URL and page title |
| `devbrowser_find_elements` | Query DOM elements by CSS selector (returns tag, text, attributes) |
| `devbrowser_get_section_text` | Get text from a specific page section by CSS selector. Pass `maxLength` to control size. |

### Search & Navigation Within Page
| Tool | Description |
|------|-------------|
| `devbrowser_find_text` | Search for text on the page. Returns matches with positions and visibility. |
| `devbrowser_scroll_to` | Scroll to a specific element by CSS selector |

### Interaction
| Tool | Description |
|------|-------------|
| `devbrowser_click` | Click an element by CSS selector |
| `devbrowser_type` | Type text into an input field |
| `devbrowser_select` | Choose a dropdown option |
| `devbrowser_scroll` | Scroll up or down by pixel amount |
| `devbrowser_execute_js` | Run arbitrary JavaScript in the page |
| `devbrowser_wait_for` | Wait for an element to appear (with timeout) |

### Screenshots
| Tool | Description |
|------|-------------|
| `devbrowser_screenshot` | Capture the page as a compressed JPEG image. Pass `maxWidth` and `quality` (jpeg/png). |

### Tab Management
| Tool | Description |
|------|-------------|
| `devbrowser_list_tabs` | List all open tabs |
| `devbrowser_new_tab` | Open a new tab |
| `devbrowser_switch_tab` | Switch to a specific tab by ID |
| `devbrowser_close_tab` | Close a tab |
| `devbrowser_quit` | Quit the DevBrowser app to free resources |

All tools accept an optional `tabId` parameter. If omitted, they target the active tab.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DEVBROWSER_PORT` | `19816` | WebSocket server port |

## File Structure

```
claude-devbrowser/
├── main.js              # Electron main process
├── preload.js           # Context bridge for renderer
├── tab-manager.js       # Tab lifecycle and webview command execution
├── ws-server.js         # WebSocket server (runs in Electron)
├── mcp-server.js        # MCP stdio server (Claude Code launches this)
├── renderer/
│   ├── index.html       # Browser UI shell
│   ├── styles.css       # Dark theme styling
│   └── renderer.js      # Tab bar, address bar, webview management
├── package.json
└── .mcp.json            # Example project-level MCP config
```

## Session Persistence

The browser uses `partition: 'persist:devbrowser'` for webview sessions. This means:
- Cookies and login sessions survive across app restarts
- You log in once, and it stays logged in
- Session data is stored in Electron's standard user data directory

## Troubleshooting

**"Could not connect to DevBrowser"** - The app should auto-launch, but if it fails, run `npm start` manually in the claude-devbrowser directory.

**Port conflict** - Set `DEVBROWSER_PORT=12345` in your environment to use a different port. Set it both when launching the app and in the MCP server config.

**Tools not appearing in Claude Code** - Run `claude mcp list` to verify the server is registered. Restart Claude Code after adding the MCP server.

#!/usr/bin/env node

/**
 * CDP Bridge — MCP server that controls Chrome via Chrome DevTools Protocol
 *
 * Connects to Chrome's debugging port (localhost:9222) and exposes browser
 * control as MCP tools over stdio. No extensions, no relay, no pipes.
 *
 * Prerequisites:
 *   Launch Chrome with: chrome.exe --remote-debugging-port=9222
 *
 * Registration:
 *   claude mcp add --transport stdio cdp-bridge -- node src/cdp-bridge.mjs
 */

import { createInterface } from "node:readline";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// ─── Configuration ──────────────────────────────────────────────────────────

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;
const CDP_TIMEOUT_MS = 15000;
const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "screenshots"
);
const CHARACTER_LIMIT = 25000;

// ─── Logging (stderr only — stdout is MCP) ──────────────────────────────────

function log(level, msg) {
  process.stderr.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

// ─── Response Truncation ────────────────────────────────────────────────────

function truncate(text) {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n--- Truncated (${text.length} chars). Use more specific queries to reduce output. ---`
  );
}

// ─── CDP HTTP helpers ───────────────────────────────────────────────────────

function cdpFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `http://${CDP_HOST}:${CDP_PORT}${endpoint}`;
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      })
      .on("error", (err) => {
        if (err.code === "ECONNREFUSED") {
          reject(
            new Error(
              `Cannot connect to Chrome on port ${CDP_PORT}. Launch Chrome with: chrome.exe --remote-debugging-port=${CDP_PORT}`
            )
          );
        } else {
          reject(new Error(`CDP HTTP error: ${err.message}`));
        }
      });
  });
}

function cdpPut(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://${CDP_HOST}:${CDP_PORT}${endpoint}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "PUT" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`CDP HTTP error: ${err.message}`)));
    req.end();
  });
}

// ─── DOM Scripts (injected via Runtime.evaluate) ────────────────────────────

const DOM_SCRIPTS = {
  pageStructure: `(() => {
    const result = { title: document.title, url: location.href, headings: [], landmarks: [], forms: [], pagination: null, stats: {} };
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      if (h.offsetParent !== null || h.offsetHeight > 0) {
        result.headings.push({ level: parseInt(h.tagName[1]), text: h.textContent.trim().slice(0, 200) });
      }
    });
    const landmarkSel = 'header,nav,main,footer,aside,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="complementary"],[role="search"],[role="region"]';
    document.querySelectorAll(landmarkSel).forEach(el => {
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
      result.landmarks.push({ role, label: label.slice(0, 100), childCount: el.children.length });
    });
    document.querySelectorAll('form').forEach(f => {
      const fields = [];
      f.querySelectorAll('input,select,textarea,button').forEach(inp => {
        const label = inp.getAttribute('aria-label') || inp.labels?.[0]?.textContent?.trim() || inp.placeholder || inp.name || '';
        fields.push({ tag: inp.tagName.toLowerCase(), type: inp.type || '', name: inp.name, label: label.slice(0, 100), required: inp.required, disabled: inp.disabled });
      });
      result.forms.push({ action: f.action, method: f.method, fields });
    });
    const pagSels = ['[class*="pagination"]', '[class*="pager"]', 'nav[aria-label*="page" i]', '[role="navigation"][aria-label*="page" i]'];
    for (const sel of pagSels) {
      const el = document.querySelector(sel);
      if (el) {
        const links = el.querySelectorAll('a, button, li');
        const pages = [];
        let current = null;
        links.forEach(l => {
          const text = l.textContent.trim();
          const num = parseInt(text);
          if (!isNaN(num)) {
            pages.push(num);
            if (l.classList.contains('active') || l.getAttribute('aria-current') === 'page') current = num;
          }
        });
        if (pages.length > 0) {
          result.pagination = { currentPage: current, pages, hasNext: !!el.querySelector('[class*="next"]:not([disabled])'), hasPrev: !!el.querySelector('[class*="prev"]:not([disabled])') };
          break;
        }
      }
    }
    result.stats = {
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button, [role="button"]').length,
      images: document.querySelectorAll('img').length,
      inputs: document.querySelectorAll('input, select, textarea').length
    };
    return JSON.stringify(result);
  })()`,

  interactiveElements: `(() => {
    const results = [];
    const seen = new Set();
    function isVisible(el) {
      if (!el.offsetParent && el.tagName !== 'BODY' && getComputedStyle(el).position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function getLabel(el) {
      return el.getAttribute('aria-label') || el.getAttribute('title') || el.labels?.[0]?.textContent?.trim() || el.textContent?.trim().slice(0, 120) || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }
    function getRegion(el) {
      let p = el.parentElement;
      while (p) {
        const role = p.getAttribute('role') || '';
        const tag = p.tagName.toLowerCase();
        if (tag === 'header' || role === 'banner') return 'header';
        if (tag === 'nav' || role === 'navigation') return 'nav';
        if (tag === 'main' || role === 'main') return 'main';
        if (tag === 'aside' || role === 'complementary') return 'sidebar';
        if (tag === 'footer' || role === 'contentinfo') return 'footer';
        p = p.parentElement;
      }
      return 'main';
    }
    document.querySelectorAll('a[href]').forEach(a => {
      if (!isVisible(a)) return;
      const key = a.href + '|' + a.textContent.trim().slice(0, 50);
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ tag: 'a', role: 'link', label: getLabel(a), href: a.href, region: getRegion(a), disabled: false });
    });
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(b => {
      if (!isVisible(b)) return;
      results.push({ tag: b.tagName.toLowerCase(), role: 'button', label: getLabel(b), region: getRegion(b), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' });
    });
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').forEach(inp => {
      if (!isVisible(inp)) return;
      results.push({
        tag: inp.tagName.toLowerCase(),
        role: inp.type === 'checkbox' ? 'checkbox' : inp.type === 'radio' ? 'radio' : inp.tagName === 'SELECT' ? 'combobox' : 'textbox',
        label: getLabel(inp),
        region: getRegion(inp),
        disabled: inp.disabled,
        value: inp.type === 'checkbox' || inp.type === 'radio' ? inp.checked : undefined
      });
    });
    return JSON.stringify({ count: results.length, elements: results });
  })()`,

  domTree: `(() => {
    const MAX_DEPTH = 8;
    const MAX_NODES = 500;
    let nodeCount = 0;
    const SEMANTIC_ROLES = {
      'A': 'link', 'BUTTON': 'button', 'INPUT': 'textbox', 'SELECT': 'combobox',
      'TEXTAREA': 'textbox', 'IMG': 'image', 'H1': 'heading', 'H2': 'heading',
      'H3': 'heading', 'H4': 'heading', 'H5': 'heading', 'H6': 'heading',
      'TABLE': 'table', 'TR': 'row', 'TH': 'columnheader', 'TD': 'cell',
      'UL': 'list', 'OL': 'list', 'LI': 'listitem', 'NAV': 'navigation',
      'MAIN': 'main', 'HEADER': 'banner', 'FOOTER': 'contentinfo',
      'ASIDE': 'complementary', 'FORM': 'form', 'DIALOG': 'dialog',
      'DETAILS': 'group', 'SUMMARY': 'button', 'SECTION': 'region'
    };
    const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','BR','HR','WBR','META','LINK']);
    function isVisible(el) {
      if (el.offsetParent === null && el.tagName !== 'BODY' && getComputedStyle(el).position !== 'fixed') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }
    function getName(el) {
      return el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.labels?.[0]?.textContent?.trim()) || '';
    }
    function getDirectText(el) {
      let text = '';
      for (const child of el.childNodes) {
        if (child.nodeType === 3) text += child.textContent;
      }
      return text.trim().slice(0, 150);
    }
    function walk(el, depth) {
      if (nodeCount >= MAX_NODES || depth > MAX_DEPTH) return null;
      if (SKIP_TAGS.has(el.tagName)) return null;
      if (!isVisible(el)) return null;
      const role = el.getAttribute('role') || SEMANTIC_ROLES[el.tagName] || '';
      const name = getName(el);
      const text = getDirectText(el);
      const level = el.tagName.match(/^H(\\d)$/) ? parseInt(el.tagName[1]) : undefined;
      const state = {};
      if (el.disabled) state.disabled = true;
      if (el.checked) state.checked = true;
      if (el.getAttribute('aria-expanded')) state.expanded = el.getAttribute('aria-expanded') === 'true';
      if (el.getAttribute('aria-selected')) state.selected = el.getAttribute('aria-selected') === 'true';
      const children = [];
      for (const child of el.children) {
        const node = walk(child, depth + 1);
        if (node) children.push(node);
      }
      if (!role && !name && !text && children.length === 1) return children[0];
      if (!role && !name && !text && children.length === 0) return null;
      nodeCount++;
      const node = {};
      if (role) node.role = role;
      if (name) node.name = name;
      if (text) node.text = text;
      if (level) node.level = level;
      if (Object.keys(state).length) node.state = state;
      if (el.tagName === 'A' && el.getAttribute('href')) node.href = el.pathname || '';
      if (el.tagName === 'IMG' && el.src) node.src = el.src.split('?')[0].slice(0, 200);
      if (children.length) node.children = children;
      return node;
    }
    const tree = walk(document.body, 0);
    return JSON.stringify({ nodeCount, truncated: nodeCount >= MAX_NODES, tree });
  })()`,
};

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "navigate",
    description:
      "Navigate the active browser tab to a URL. Waits for the page to finish loading before returning.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "tab_list",
    description:
      "List all open browser tabs. Returns each tab's id, title, URL, and whether it is the active tab.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tab_new",
    description:
      "Open a new browser tab, optionally navigating to a URL. The new tab becomes the active tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open (optional, defaults to blank tab)",
        },
      },
      required: [],
    },
  },
  {
    name: "tab_close",
    description: "Close a browser tab by its ID. If closing the active tab, switches to the first remaining tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "The tab ID to close" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "tab_switch",
    description: "Switch the active tab to the one with the given ID.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "string",
          description: "The tab ID to switch to",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "click",
    description:
      'Click on an element identified by CSS selector. Finds the element, scrolls it into view, and clicks its center. Example: click({ selector: "#submit-btn" })',
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "type",
    description:
      'Type text into an element identified by CSS selector. Focuses the element, clears it, and types the text. Example: type({ selector: "input[name=search]", text: "hello" })',
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input element",
        },
        text: { type: "string", description: "Text to type" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "key_press",
    description:
      'Send a keyboard event. Supports keys like Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Delete, and any single character.',
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key to press (e.g. Enter, Escape, Tab, ArrowDown, a, 1)",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "read_page",
    description:
      "Get the visible text content of the current page. Returns the innerText of the document body.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the current page. Saves as PNG and returns the file path.",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page (default: false, viewport only)",
        },
        savePath: {
          type: "string",
          description: "Directory to save the screenshot in (optional, defaults to screenshots/ in the cdp-bridge project folder). The directory will be created if it doesn't exist.",
        },
      },
      required: [],
    },
  },
  {
    name: "javascript_exec",
    description:
      "Execute JavaScript code in the browser page context and return the result. The code should return a value (use JSON.stringify for objects).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to execute" },
      },
      required: ["code"],
    },
  },
  {
    name: "get_page_structure",
    description:
      "Get a structured overview of the current page: title, URL, headings, ARIA landmarks, forms, pagination, and element counts. Use this FIRST when exploring any page.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_interactive_elements",
    description:
      "Get all visible interactive elements on the page: links, buttons, and inputs with their labels, regions, and states.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_dom_tree",
    description:
      "Get a DOM-based accessibility tree approximation. Max 500 nodes, 8 levels deep. Use for deep structural understanding of the page.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ─── Key code mapping for Input.dispatchKeyEvent ────────────────────────────

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, nativeVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35, nativeVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33, nativeVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34, nativeVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, nativeVirtualKeyCode: 32 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CDP Bridge
// ═══════════════════════════════════════════════════════════════════════════════

class CdpBridge {
  constructor() {
    // Tab tracking: tabId -> { ws, info }
    this.tabs = new Map();
    this.activeTabId = null;
    this.cdpIdCounter = 0;
    this.pendingCdp = new Map(); // cdpId -> { resolve, reject, timer }
  }

  // ── MCP stdout ────────────────────────────────────────────────────────

  sendToStdout(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  sendError(id, code, message) {
    if (id !== undefined) {
      this.sendToStdout({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  sendToolResult(id, content, isError = false) {
    const text = isError ? content : truncate(content);
    this.sendToStdout({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError },
    });
  }

  // ── CDP WebSocket per tab ─────────────────────────────────────────────

  connectToTab(tabInfo) {
    return new Promise((resolve, reject) => {
      const wsUrl = tabInfo.webSocketDebuggerUrl;
      if (!wsUrl) {
        reject(new Error(`Tab "${tabInfo.title}" has no debugger URL — it may already be attached to DevTools.`));
        return;
      }

      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        log("INFO", `Connected to tab: ${tabInfo.title} (${tabInfo.id})`);
        this.tabs.set(tabInfo.id, { ws, info: tabInfo });
        resolve(tabInfo.id);
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pendingCdp.has(msg.id)) {
            const pending = this.pendingCdp.get(msg.id);
            clearTimeout(pending.timer);
            this.pendingCdp.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`CDP error: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (err) {
          log("WARN", `Failed to parse CDP message: ${err.message}`);
        }
      });

      ws.on("close", () => {
        log("INFO", `Tab disconnected: ${tabInfo.id}`);
        this.tabs.delete(tabInfo.id);
        if (this.activeTabId === tabInfo.id) {
          const remaining = [...this.tabs.keys()];
          this.activeTabId = remaining.length > 0 ? remaining[0] : null;
          log("INFO", `Active tab switched to: ${this.activeTabId}`);
        }
      });

      ws.on("error", (err) => {
        log("ERROR", `Tab WebSocket error (${tabInfo.id}): ${err.message}`);
        reject(err);
      });
    });
  }

  sendCdp(method, params = {}, tabId = null) {
    const targetId = tabId || this.activeTabId;
    if (!targetId || !this.tabs.has(targetId)) {
      return Promise.reject(
        new Error(
          "No active tab. Use tab_list to see available tabs, or tab_new to open one."
        )
      );
    }

    const { ws } = this.tabs.get(targetId);
    const id = ++this.cdpIdCounter;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCdp.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${CDP_TIMEOUT_MS / 1000}s`));
      }, CDP_TIMEOUT_MS);

      this.pendingCdp.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // ── Initialize: discover existing tabs ────────────────────────────────

  async discoverTabs() {
    try {
      const targets = await cdpFetch("/json/list");
      const pages = targets.filter((t) => t.type === "page");

      if (pages.length === 0) {
        log("INFO", "No browser tabs found");
        return;
      }

      for (const page of pages) {
        try {
          await this.connectToTab(page);
        } catch (err) {
          log("WARN", `Could not connect to tab "${page.title}": ${err.message}`);
        }
      }

      if (this.tabs.size > 0 && !this.activeTabId) {
        this.activeTabId = [...this.tabs.keys()][0];
        log("INFO", `Active tab: ${this.activeTabId}`);
      }
    } catch (err) {
      log("ERROR", `Tab discovery failed: ${err.message}`);
    }
  }

  // ── Tool handlers ─────────────────────────────────────────────────────

  async handleTool(id, name, args) {
    try {
      let result;
      switch (name) {
        case "navigate":
          result = await this.toolNavigate(args);
          break;
        case "tab_list":
          result = await this.toolTabList();
          break;
        case "tab_new":
          result = await this.toolTabNew(args);
          break;
        case "tab_close":
          result = await this.toolTabClose(args);
          break;
        case "tab_switch":
          result = await this.toolTabSwitch(args);
          break;
        case "click":
          result = await this.toolClick(args);
          break;
        case "type":
          result = await this.toolType(args);
          break;
        case "key_press":
          result = await this.toolKeyPress(args);
          break;
        case "read_page":
          result = await this.toolReadPage();
          break;
        case "screenshot":
          result = await this.toolScreenshot(args);
          break;
        case "javascript_exec":
          result = await this.toolJsExec(args);
          break;
        case "get_page_structure":
          result = await this.toolEvalScript(DOM_SCRIPTS.pageStructure);
          break;
        case "get_interactive_elements":
          result = await this.toolEvalScript(DOM_SCRIPTS.interactiveElements);
          break;
        case "get_dom_tree":
          result = await this.toolEvalScript(DOM_SCRIPTS.domTree);
          break;
        default:
          this.sendError(id, -32601, `Unknown tool: ${name}`);
          return;
      }
      this.sendToolResult(id, typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } catch (err) {
      log("ERROR", `Tool "${name}" failed: ${err.message}`);
      this.sendToolResult(id, `Error: ${err.message}`, true);
    }
  }

  // ── Individual tool implementations ───────────────────────────────────

  async toolNavigate({ url }) {
    if (!url) throw new Error("url is required");
    // Enable page events so we can wait for load
    await this.sendCdp("Page.enable");
    const navResult = await this.sendCdp("Page.navigate", { url });
    if (navResult.errorText) {
      throw new Error(`Navigation failed: ${navResult.errorText}`);
    }
    // Wait for page to load
    await this.waitForLoad();
    const info = await this.sendCdp("Runtime.evaluate", {
      expression: "JSON.stringify({ title: document.title, url: location.href })",
      returnByValue: true,
    });
    const page = JSON.parse(info.result.value);
    // Update tab info
    const tab = this.tabs.get(this.activeTabId);
    if (tab) {
      tab.info.title = page.title;
      tab.info.url = page.url;
    }
    return { navigated: true, title: page.title, url: page.url };
  }

  async waitForLoad() {
    // Poll document.readyState until complete, with timeout
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await this.sendCdp("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (res.result.value === "complete") return;
      } catch {
        // page might be navigating, retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async toolTabList() {
    // Refresh tab info from CDP
    try {
      const targets = await cdpFetch("/json/list");
      const pages = targets.filter((t) => t.type === "page");
      return {
        activeTabId: this.activeTabId,
        tabs: pages.map((t) => ({
          id: t.id,
          title: t.title,
          url: t.url,
          active: t.id === this.activeTabId,
          connected: this.tabs.has(t.id),
        })),
      };
    } catch (err) {
      throw new Error(`Failed to list tabs: ${err.message}`);
    }
  }

  async toolTabNew({ url } = {}) {
    const endpoint = url ? `/json/new?${url}` : "/json/new";
    const tabInfo = await cdpPut(endpoint);
    if (!tabInfo.id) throw new Error("Failed to create new tab");
    await this.connectToTab(tabInfo);
    this.activeTabId = tabInfo.id;
    if (url) {
      await this.waitForLoad();
    }
    return { created: true, tabId: tabInfo.id, title: tabInfo.title, url: tabInfo.url };
  }

  async toolTabClose({ tabId }) {
    if (!tabId) throw new Error("tabId is required");
    // Close WebSocket if connected
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.ws.close();
      this.tabs.delete(tabId);
    }
    await cdpPut(`/json/close/${tabId}`);
    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[0] : null;
    }
    return { closed: true, tabId, activeTabId: this.activeTabId };
  }

  async toolTabSwitch({ tabId }) {
    if (!tabId) throw new Error("tabId is required");
    if (!this.tabs.has(tabId)) {
      // Try to connect to it
      const targets = await cdpFetch("/json/list");
      const target = targets.find((t) => t.id === tabId);
      if (!target) throw new Error(`Tab ${tabId} not found`);
      await this.connectToTab(target);
    }
    // Bring tab to front
    await cdpPut(`/json/activate/${tabId}`);
    this.activeTabId = tabId;
    const tab = this.tabs.get(tabId);
    return { switched: true, tabId, title: tab?.info.title, url: tab?.info.url };
  }

  async toolClick({ selector }) {
    if (!selector) throw new Error("selector is required");
    // Find element, scroll into view, get center coordinates, click
    const evalResult = await this.sendCdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ error: "Element not found: ${selector.replace(/"/g, '\\"')}" });
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: el.textContent.trim().slice(0, 100) });
      })()`,
      returnByValue: true,
    });

    const coords = JSON.parse(evalResult.result.value);
    if (coords.error) throw new Error(coords.error);

    // Dispatch mouse events: move, down, up (simulates a real click)
    await this.sendCdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: coords.x,
      y: coords.y,
    });
    await this.sendCdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });

    return { clicked: true, selector, tag: coords.tag, text: coords.text };
  }

  async toolType({ selector, text }) {
    if (!selector) throw new Error("selector is required");
    if (text === undefined) throw new Error("text is required");

    // Focus and clear the element
    await this.sendCdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: ${selector.replace(/"/g, '\\"')}");
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    });

    // Type each character using Input.dispatchKeyEvent
    for (const char of text) {
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: char,
      });
    }

    return { typed: true, selector, length: text.length };
  }

  async toolKeyPress({ key }) {
    if (!key) throw new Error("key is required");

    const mapped = KEY_MAP[key];
    if (mapped) {
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.nativeVirtualKeyCode,
        nativeVirtualKeyCode: mapped.nativeVirtualKeyCode,
      });
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.nativeVirtualKeyCode,
        nativeVirtualKeyCode: mapped.nativeVirtualKeyCode,
      });
    } else {
      // Single character
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: key,
        key: key,
        unmodifiedText: key,
      });
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: key,
      });
    }

    return { pressed: true, key };
  }

  async toolReadPage() {
    const result = await this.sendCdp("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true,
    });
    return result.result.value || "";
  }

  async toolScreenshot({ fullPage, savePath } = {}) {
    // Use custom save path if provided, otherwise default
    const targetDir = savePath || SCREENSHOT_DIR;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    let clip;
    if (fullPage) {
      // Get full page dimensions
      const metrics = await this.sendCdp("Page.getLayoutMetrics");
      clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    }

    const result = await this.sendCdp("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(targetDir, filename);

    fs.writeFileSync(filepath, Buffer.from(result.data, "base64"));
    log("INFO", `Screenshot saved: ${filepath}`);

    return { saved: true, path: filepath, fullPage: !!fullPage };
  }

  async toolJsExec({ code }) {
    if (!code) throw new Error("code is required");
    const result = await this.sendCdp("Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `JS error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`
      );
    }
    const val = result.result.value;
    return val !== undefined ? String(val) : "undefined";
  }

  async toolEvalScript(script) {
    const result = await this.sendCdp("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Script error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`
      );
    }
    // Try to pretty-format JSON
    try {
      return JSON.stringify(JSON.parse(result.result.value), null, 2);
    } catch {
      return String(result.result.value);
    }
  }

  // ── MCP message handling ──────────────────────────────────────────────

  handleStdinMessage(msg) {
    log("DEBUG", `→ stdin: ${JSON.stringify(msg).slice(0, 300)}`);

    if (msg.method === "initialize") {
      this.sendToStdout({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cdp-bridge", version: "1.0.0" },
        },
      });
      return;
    }

    if (msg.method === "notifications/initialized") {
      log("INFO", "MCP initialized, discovering tabs...");
      this.discoverTabs();
      return;
    }

    if (msg.method === "tools/list") {
      this.sendToStdout({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (msg.method === "tools/call") {
      this.handleTool(msg.id, msg.params?.name, msg.params?.arguments || {});
      return;
    }

    if (msg.method === "ping") {
      this.sendToStdout({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    // Unknown method
    if (msg.id !== undefined) {
      this.sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  // ── Entry point ───────────────────────────────────────────────────────

  start() {
    log("INFO", "CDP Bridge starting");
    log("INFO", `Chrome target: http://${CDP_HOST}:${CDP_PORT}`);
    log("INFO", `Screenshot dir: ${SCREENSHOT_DIR}`);
    log("INFO", `Tools: ${TOOLS.map((t) => t.name).join(", ")}`);

    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.handleStdinMessage(JSON.parse(trimmed));
      } catch (err) {
        log("WARN", `stdin parse error: ${err.message}`);
      }
    });

    rl.on("close", () => {
      log("INFO", "stdin closed, exiting");
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());

    // Discover existing tabs on startup
    this.discoverTabs();
  }

  cleanup() {
    log("INFO", "Shutting down");
    for (const [tabId, { ws }] of this.tabs) {
      ws.close();
    }
    this.tabs.clear();
    // Reject pending CDP calls
    for (const [id, pending] of this.pendingCdp) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge shutting down"));
    }
    this.pendingCdp.clear();
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

const bridge = new CdpBridge();
bridge.start();

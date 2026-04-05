---
name: cdp-browser-nav
description: How to effectively use the CDP bridge MCP tools (mcp__cdp-bridge__*) for browser automation. Use this skill whenever performing browser tasks — navigating websites, interacting with pages, reading content, taking screenshots, or extracting data. Triggers on any browser-related request involving the cdp-bridge MCP tools, @browser references, or tasks involving web pages, clicking, scrolling, screenshots, or page interaction.
---

# CDP Browser Navigation

You have access to a set of browser automation tools via the `cdp-bridge` MCP server. These tools control a real Chrome browser through the Chrome DevTools Protocol. The browser is visible to the user — they can see everything happening in real time and can intervene manually at any point.

## Prerequisites

Chrome must be running with `--remote-debugging-port=9222`. If you get a connection refused error, tell the user to close all Chrome windows and relaunch with that flag.

## Available Tools

**Navigation & Tabs:**
- `navigate` — go to a URL
- `tab_list` — list open tabs (id, title, url)
- `tab_new` — open a new tab (optionally with a URL)
- `tab_close` — close a tab by ID
- `tab_switch` — switch active tab by ID

**Interaction:**
- `click` — click an element by CSS selector
- `type` — type text into an element by CSS selector
- `key_press` — send keyboard events (Enter, Escape, Tab, arrows, etc.)

**Reading:**
- `read_page` — get visible text content of the page
- `screenshot` — capture the page as PNG, returns file path
- `javascript_exec` — run arbitrary JS in the page context

**Structured DOM analysis:**
- `get_page_structure` — headings, landmarks, forms, pagination, element counts
- `get_interactive_elements` — all visible links, buttons, inputs with labels and regions
- `get_dom_tree` — accessibility tree approximation (500 nodes, 8 levels deep)

## Two Modes of Operation

Choose your approach based on what the task actually requires. This is the most important decision you make for each browser task.

### Visual Mode — "Browse like a human"

Use this when the task involves navigating a website, exploring pages, finding sections, or interacting with UI elements. This is how a person would use a browser.

**The pattern:**
1. Take a screenshot to see the page
2. Look at the screenshot to understand the layout
3. Identify what to click/interact with based on what you see
4. Perform the action (click, scroll, type)
5. Take another screenshot to confirm the result
6. Repeat

**When to use visual mode:**
- Navigating to a specific section or category on a website
- Filling out forms or completing multi-step workflows
- Exploring an unfamiliar page to understand its layout
- Any task where the user would say "go to X and find Y"
- When elements are rendered as images (common in banners, carousels)

**Key behaviors:**
- Always screenshot first before trying to interact with a page. The screenshot is your eyes — without it, you're guessing.
- After every significant action (click, navigate, scroll), take a screenshot to confirm what happened. The user is watching the browser — stay in sync with what they see.
- When a click by CSS selector fails, don't spiral into DOM inspection. Instead, scroll to reveal the element, take a screenshot, and try a different selector based on what you see. Or use `javascript_exec` to click by coordinates from the screenshot.
- Scroll incrementally and screenshot to explore a page. Don't try to parse the entire DOM to find something — just scroll and look, like a human would.
- Carousels, sliders, and banners often render category labels as images (not text). DOM text searches will find nothing. Use screenshots to read these visual elements.

### Mechanical Mode — "Extract like an engineer"

Use this when the task is about getting specific data out of a page, reading tables, extracting structured content, or checking specific values.

**The pattern:**
1. Use `get_page_structure` to orient yourself
2. Use `javascript_exec` or the DOM tools to extract exactly what you need
3. Return the structured data

**When to use mechanical mode:**
- Extracting table data or structured content
- Reading specific text content from known locations
- Checking for the presence of specific elements
- Gathering data across multiple pages (pagination)
- Any task where the user wants structured data back, not navigation

**Key behaviors:**
- Use `get_page_structure` as a fast first step to understand the page layout.
- Use `get_interactive_elements` when you need to find clickable or input elements programmatically.
- Use `javascript_exec` for precise extraction — write targeted queries rather than pulling everything at once.
- Use `get_dom_tree` when you need to understand nested component structures.

### Blended approach

Many tasks combine both modes. For example:
- **Visual** to navigate to the right page, then **mechanical** to extract the data
- **Mechanical** (`get_page_structure`) to orient, then **visual** (screenshot) to verify you're on the right page before clicking

Use your judgment. The point is: don't use JS DOM queries to navigate a website, and don't take 10 screenshots to read a table.

## Common Patterns

### Starting a session
Always start by either listing existing tabs (`tab_list`) or creating a new one (`tab_new`). If you get "No active tab", you need to do this first.

### Clicking elements on dynamic pages
Many modern sites (SPAs, dynamic web apps) use JavaScript click handlers, images as buttons, or carousel-based navigation. CSS selectors alone often fail. When `click` by selector doesn't work:

1. Use `javascript_exec` to find the element and get its bounding box coordinates
2. Use those coordinates to dispatch a click via `javascript_exec`:
   ```js
   const el = document.elementFromPoint(x, y);
   el.click();
   ```
3. Or scroll the element into view first, then retry the selector

### Navigating image-heavy pages
Some pages render navigation elements as images rather than text:
- Banner areas (images, not clickable text)
- Category navigation (often a carousel of image-based categories)
- Content grids below

Use screenshots to identify these elements since DOM text searches will find nothing.

### Waiting for content
After navigation or clicks, pages may take time to load (SPAs, lazy loading). If content seems missing:
1. Wait a moment using `javascript_exec` with `await new Promise(r => setTimeout(r, 1000))`
2. Take a screenshot to check if content has loaded
3. Use `javascript_exec` to check `document.readyState`

### Screenshots
Always pass the `savePath` parameter pointing to a `screenshots/` folder inside the **current working project directory** — not the cdp-bridge project. This keeps screenshots co-located with whatever project you're working on. The directory will be created automatically if it doesn't exist.

Example: if you're working in `/home/user/my-project/`, pass `savePath: "/home/user/my-project/screenshots/"`.

After taking a screenshot, read the file with the Read tool to actually see it. The screenshot tool only returns the file path — you need to look at the image to gain visual context.

## Error Handling

- **"No active tab"** — call `tab_list` or `tab_new` first
- **"Cannot connect to Chrome on port 9222"** — Chrome isn't running with the debug flag. Tell the user to close all Chrome windows and relaunch with `--remote-debugging-port=9222`
- **"Element not found"** — take a screenshot to see what's actually on the page, then adjust your selector
- **CDP command timeout** — the page may be unresponsive. Try refreshing with `navigate` to the current URL
- **Tab disconnected** — the tab was closed externally. Use `tab_list` to see what's still available

## Things to Avoid

- Don't use DOM queries as a substitute for visual navigation. If you need to find a specific section on a page, screenshot and click — don't grep the DOM for category links.
- Don't take excessive screenshots during data extraction. If you need to read a list of items, use `javascript_exec` once — don't screenshot each one.
- Don't assume text in banners/carousels is in the DOM. It's often baked into images.
- Don't retry the same failing click selector more than twice. Switch to coordinates or a different approach.
- Don't forget to screenshot after actions. The user is watching the browser — if you navigate somewhere, confirm it worked visually before moving on.

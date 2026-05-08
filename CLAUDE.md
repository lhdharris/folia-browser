# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Folia Browser** — a frameless, transparent, single-page Electron browser (`electron-app/`) that wraps a `<webview>`. Each invocation of `folia-browser <url>` opens a new window; there are no tabs by design. Every link that wants a new context (`target="_blank"`, `window.open()`, OAuth popups, middle-click) opens its own BrowserWindow. The `.desktop` entry registers it as the http/https/html MIME handler.

Distribution is via an `.rpm` for Linux (openSUSE / Fedora-family) and a `.zip` of the `.app` for macOS — both produced by `electron-builder`.

## Common commands

```bash
# Run in dev (from electron-app/)
cd electron-app && npm install && npm start
cd electron-app && npm start -- https://example.com   # pass a URL

# Build the Linux RPM  →  electron-app/dist/folia-browser-1.0.0.x86_64.rpm
cd electron-app && npm run build:linux

# Build the macOS zip (cross-compile from Linux is unsupported by electron-builder; build on a Mac)
cd electron-app && npm run build:mac
```

There is no test suite or linter configured.

## Architecture notes that aren't obvious from a single file

- **The `electron` dependency is Castlabs ECS** (`https://github.com/castlabs/electron-releases#v42.0.0+wvcus`), not stock Electron. Vanilla Electron has no working Widevine integration; ECS adds Chromium's Component Updater Service so the CDM installs on first launch. `main.js` `await`s `components.whenReady()` before opening any BrowserWindow. On Linux, the first-time CDM install requires an app restart before EME works (sandboxing, per Castlabs docs). Full setup notes in `DRM_SETUP.md`. The Castlabs supported-versions window is ~1 year of Chromium releases — when v42 falls out of support, bump to the latest `+wvcus` release in `package.json`.

- **Per-site cookie/storage isolation** is implemented in `renderer/toolbar.js` by setting `partition="persist:<hostname>"` on the `<webview>` *before* `src`. Profiles live under `~/.config/folia-browser` (Linux) / `~/Library/Application Support/folia-browser` (macOS) and survive uninstall.

- **Frameless + transparent window with rounded corners** is the source of most quirks. Three load-bearing details:
  - `main.js` sizes the `BrowserWindow` to content size **plus a 24px-per-side gutter** (`WINDOW_PADDING`). The visible app is `#app` in `style.css`, inset by 24px so its `box-shadow` and `border-radius` render against the desktop.
  - The window has no OS frame, so window controls (close/min/max) are HTML buttons that round-trip through `preload.js` → `ipcMain` handlers (`wm-close`, `wm-minimize`, `wm-maximize`) in `main.js`. The preload bridge is the only API exposed to the renderer (`window.wm`).
  - **Maximize is faked.** `main.js` listens for `enter-full-screen` and immediately cancels it, then resizes to `workArea`. Do **not** add a `maximize` event listener — on GNOME, calling `setBounds()` near workArea size re-fires `maximize` and infinite-recurses (comment in `main.js` warns about this). `preMaxBounds` (Map<win.id, bounds>) is what makes the WM-button toggle restore correctly.

- **Webview src must be set after layout.** `renderer/toolbar.js` defers `webview.setAttribute('src', url)` until `window.load + 50ms`. Setting `src` earlier locks the guest viewport to whatever tiny size the `<webview>` had during the frameless/transparent window's async layout, and the page renders permanently at that size. The `dom-ready` handler also fires a synthetic `resize` to nudge the guest if the element resized after guest attach. Don't "simplify" this — the comment in the file is the bug history.

- **URL bar → action label**, also in `renderer/toolbar.js`. The URL bar is a one-shot input on a blank window: on Enter it fades out, gets removed from the DOM, and is replaced by a static label (`#action-label`) that says either "searched for '…'" or "visited <hostname>" — set once, never updated. The classifier mirrors `main.js`'s `resolveUrl` heuristic.

- **Single-instance behavior:** `app.requestSingleInstanceLock()` plus a `second-instance` handler means subsequent `folia-browser <url>` invocations open a new window in the existing process rather than starting another Electron. URL parsing for argv ignores flags (`!a.startsWith('-')`) so Electron flags don't get confused for the URL.

- **Popup handling:** the `<webview>` tag in `renderer/index.html` carries `allowpopups` — without it, Chromium silently drops `window.open()` inside the webview's renderer and `setWindowOpenHandler` never fires. With it set, `setWindowOpenHandler` in `main.js` splits on disposition: `new-window` (OAuth popups, `window.open(url, name, "width=…,height=…")`) is allowed as a real popup so `window.opener.postMessage` and `window.close` can round-trip the auth handshake — the OS frame is the trade-off. Everything else (`target="_blank"`, plain `window.open(url)`, middle-click) is denied at the popup layer and re-opened via `createWindow(newUrl)` — the same code path the menu's "New window" uses — so it gets the full Folia shell (toolbar, frameless rounded chrome, per-site partition picked from hostname in `renderer/toolbar.js`). `save-to-disk` is denied; downloads come through `session.on('will-download')`.

- **`electronDownload` mirror in `package.json`** points electron-builder at Castlabs' GitHub release assets (`v${version}` tag, `electron-v${version}-${platform}-${arch}.zip` filename). Without this, electron-builder defaults to the official Electron mirror, which doesn't have `+wvcus` releases — cross-platform builds (e.g. Mac from Linux) would fail silently with a "version not found" download error.

## Things to know before editing

- The renderer is locked down by CSP (`default-src 'self'; script-src 'self'`) — no inline scripts, no remote scripts. The `<webview>` is the escape hatch for arbitrary web content.
- Do not commit `electron-app/dist/` (build output) or `electron-app/node_modules/` — both ignored via `.gitignore`.

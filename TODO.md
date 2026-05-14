# Folia Browser 1.1 — To-Do

Branch: `tabless-browser-1.1`. All "done" items below are **uncommitted in the
working tree** — the user is keeping the branch as WIP until further notice.
`git status` is authoritative; this file may drift.

See `CHANGELOG.md` for a written summary of what 1.1 contains so far.

## Done

- [x] Fix icons (`build/icon.png`, `build/icon.ico`, `build/icons/`; macOS
      `package.json` switched from `.icns` to `.png`).
- [x] Right-click context menu in web content (`main.js`
      `wvContents.on('context-menu')`): open link in new window, copy link
      address, cut/copy/paste/select-all in editable fields, "Search '…' in
      new window" using the configured engine.
- [x] Make Ecosia the default search engine (added as a `Settings → Search
      engine` option, set as the default in `SETTINGS_DEFAULTS`, and the URL
      bar's search fallback now routes through `searchUrl()` rather than
      hard-coded DuckDuckGo).
- [x] Simplify URL-bar action label (`renderer/toolbar.js`
      `actionLabelText`): URLs render as the bare hostname (`github.com`),
      searches as the quoted query (`'why is my child crying?'`).
- [x] Toolbar ⋮ dropdown additions (`main.js` `show-context-menu` handler):
      Refresh, Copy URL, Print page to PDF…  (Disabled when the window has
      no page loaded yet.)
- [x] Save page as PDF (`webContents.printToPDF` + `dialog.showSaveDialog`,
      filename derived from `webContents.getTitle()`, default folder =
      `effectiveDownloadDir()`).
- [x] Global zoom setting (`SETTINGS_DEFAULTS.zoom`, applied on every
      `dom-ready` so cross-origin nav doesn't reset it, and re-broadcast to
      every open window on `settings-save`). UI is a `<select>` in
      Settings → Zoom (50–200%).
- [x] Bump `package.json` version to `1.1.0`.
- [x] Add `CHANGELOG.md` at repo root (Keep-a-Changelog format).
- [x] **Pastel colour hues when multiple windows are open.** Toolbar
      background only. Hue assignment lives in `main.js` (`windowHues` map +
      `assignHue` largest-gap fallback); renderer just receives a hue or
      null via `'hue-changed'` IPC and writes `--toolbar-bg`. Single
      navigated window → no tint (grey). 2+ windows → each gets a pastel
      (`hsl(h, 50%, 90%)`) preferring `hostnameHue()`, sliding into the
      largest gap if within 70% of equal spacing from any existing window's
      hue. Sticky — existing windows keep their colour when others
      open/close. Toggle in Settings → Appearance, default on.
- [x] **Permissions UI (camera / mic / location) — case-by-case prompts
      with a lock icon next to the ⋮ menu.** Implementation:
      `main.js` `setPermissionRequestHandler` routes `media`/`geolocation`
      to a per-hostname grant lookup (`settings.permissionGrants`); missing
      decisions trigger an IPC `'permission-request'` to the owning
      window's renderer, which shows a popover prompt (Allow / Block, both
      remembered). `notifications` is hard-denied unconditionally (no UI).
      Combined `getUserMedia({audio,video})` is one prompt, atomic grant.
      Lock visibility: hidden until a permission is requested or already
      granted for the current hostname. Active "in use" detection: a new
      `webview-preload.js` injects wrappers around `getUserMedia` and
      `navigator.geolocation.{getCurrentPosition,watchPosition,clearWatch}`
      into the page's main world via `webFrame.executeJavaScript` (bypasses
      page CSP), bridges back to the host renderer through
      `window.postMessage` → `ipcRenderer.sendToHost('folia-permission-active')`.
      Lock turns green + swaps to open-lock SVG while any tracked stream
      or watch is live. Click lock outside of a prompt → manage popover
      with Allow / Block / Ask segmented controls per kind. In-flight
      prompts are denied if the window closes mid-prompt (so the page's
      promise doesn't hang).
- [x] **Cascade new windows.** New windows inherit the opener's size and are
      offset 32 px down-and-right. The opener is the window the navigation
      actually came from (closure `win` in `setWindowOpenHandler`, the
      context-menu's owning window, or the window whose ⋮ menu fired "New
      window") — not just `BrowserWindow.getFocusedWindow()` (which is only
      the fallback for second-instance launches, `open-url`, and dock
      activate). Cascade wraps back to the opener's own origin once it would
      push the window off the display's work area. Maximized opener →
      cascade is sized to work-area minus a 32 px margin and placed at the
      work-area origin + 32 px. Implementation: `cascadedBoundsFrom()` in
      `main.js`.
- [x] **Fix YouTube fullscreen only filling frame.** Guest webContents'
      `enter-html-full-screen` / `leave-html-full-screen` events drive the
      host BrowserWindow into real `setFullScreen(true)` and toggle a
      `body.html-fullscreen` class in the renderer to hide the toolbar
      (`main.js`, `preload.js`, `renderer/toolbar.js`, `renderer/style.css`).
      A `win._htmlFullscreen` flag gates the existing Linux
      `enter-full-screen → maximize` intercept so page-driven fullscreen
      isn't reverted.
- [x] **Fix Ratta Supernote screen sharing not appearing in frame.** Root
      cause wasn't `getDisplayMedia` — the Supernote serves its mirror over
      plain HTTP at `10.4.20.88:8080`, and `resolveUrl()` was prefixing every
      URL-bar entry with `https://`, so the load failed with
      `ERR_SSL_PROTOCOL_ERROR`. Fix in `main.js`: `isLocalHost()` detects
      `localhost` and IPv4 literals, and `resolveUrl()` uses `http://` for
      those (public hostnames still default to HTTPS).
- [x] **Add screen-share picker (`getDisplayMedia`).** Originally chased as
      the Supernote fix; turned out to be unrelated but is still required
      for Jitsi / Google Meet / Discord screen-share. Each guest session
      registers `setDisplayMediaRequestHandler`, which opens a modal "Choose
      what to share" picker (`renderer/screen-picker.{html,css,js}`) listing
      screens and windows from `desktopCapturer.getSources` with thumbnails.
      `__foliaDcAttached` dedupes the handler across webviews that share a
      partition. Esc / Cancel / X all resolve as "deny" so the page's
      `getDisplayMedia` promise rejects cleanly.

## Pending

- [x] **GitHub-tracking auto-updater.** Hand-rolled (not `electron-updater`)
      so the download flows through the existing toolbar download-ring UI:
      `electron-app/updater.js` fetches `/releases/latest`, compares version,
      shows a native dialog, and on yes calls
      `session.fromPartition('persist:folia').downloadURL(asset_url)`. Installer
      format auto-detects per platform (darwin→dmg, win32→exe, linux→rpm/deb
      from `/etc/os-release` ID/ID_LIKE). User runs the installer manually
      from the downloads folder — no silent install (rpm/deb need sudo and
      we don't want to mid-flight-replace the running binary anyway).
      Requires a public GitHub Release to exist with the expected assets;
      first release needs to be created manually via `gh release create`
      after `npm run build:linux` (and `build:win`/`build:mac` where
      applicable).
- [x] **Fix multiple Google logins issue.** Needs repro. Partition is
      `persist:<hostname>` (`renderer/toolbar.js`), so two windows on
      `accounts.google.com` share cookies. Symptom unclear — does logging
      into Gmail B kick out Gmail A, or is it OAuth-flow-related? Ask the
      user for steps before changing the partition strategy.
- [x] **Create installers** for Windows, macOS, Linux AppImage, `.deb`,
      `.rpm`. Currently `package.json` `build.linux.target` is only
      `["rpm"]`. Add `deb` and `AppImage`. Win NSIS config exists. Mac
      build needs a Mac host; signing identity is currently `null`.

## Two pending choices for the user to confirm

1. Menu item label is "Print page to PDF…" (with ellipsis, since a save
   dialog follows). User wrote it without an ellipsis — happy to drop.
2. `resolveUrl()` now respects the search engine setting for URL-bar input
   (previously DDG-only). Not in the original list but a natural follow-on
   from making Ecosia the default. User wanted to verify.

## Notes for next session

- Existing 1.0 architecture: see `CLAUDE.md`. Key constraints —
  `did-attach-webview` is the only place to grab the guest `webContents`
  (we store it on `win._guest`); zoom must be applied on `dom-ready`
  because cross-origin nav resets it; the URL bar is a one-shot input on
  blank windows and is removed once submitted.
- The user previously had the **packaged RPM build** installed at
  `/opt/Folia Browser/folia-browser`. The first dev test failed because
  the desktop launcher / `folia-browser` command runs the *installed*
  build, not `npm start`. Kill that process before `npm start`, or run
  with `cd electron-app && npm start`.

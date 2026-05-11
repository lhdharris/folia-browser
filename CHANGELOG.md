# Changelog

All notable changes to Folia Browser are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2]

### Changed
- Save page as PDF now shows the download ring in the toolbar after the
  save dialog closes: the ring tracks the PDF generation + write, turns
  green with a checkmark when it's saved, and opens the containing folder
  (with the file highlighted) on click. The native save dialog still
  always opens first — PDF save is a deliberate user action and always
  prompts for filename and location, independent of the
  "Ask where to save each file" setting which only governs background
  downloads.

### Fixed
- Window title now reads "Folia Browser" instead of "folia-browser" in
  taskbars, multitasking / overview views, and Alt-Tab. `renderer/index.html`
  was missing a `<title>` element, so Electron fell back to `app.getName()`
  (the lowercase package name).

## [1.1.0] — Unreleased

### Added
- Right-click context menu inside web content: Open link in new window, Copy
  link address, Cut/Copy/Paste/Select all in editable fields, and "Search '…'
  in new window" using the configured search engine.
- Toolbar dropdown (⋮) gains Refresh, Copy URL, and Save page as PDF.
- Save-page-as-PDF via the dropdown (uses `webContents.printToPDF` and a
  native save dialog; default filename derived from the page title).
- Global zoom setting (50–200%) in Settings. Applies to every page across
  every window and is re-applied on each navigation.
- Ecosia as a search engine option, and set as the new default.
- Pastel toolbar hues when multiple windows are open. Each window gets a
  soft `hsl(h, 50%, 90%)` tint derived from its hostname, with adjacent
  windows spaced around the colour wheel so "the blue one" is identifiable
  at a glance. A single window stays default grey. Toggle in Settings →
  Appearance.
- New windows cascade from their opener: same size as the source window,
  offset 32 px down-and-right. The opener is whichever window the navigation
  came from (the page that called `window.open`, the right-click "Open in
  new window" target, or the window whose ⋮ menu triggered "New window") —
  not just the focused window. Cascaded position wraps back to the opener's
  own origin once it would push the new window off the work area. If the
  opener is larger than the work area (e.g. maximized), the new window is
  sized to fit the work area minus a 32 px margin and placed at the work
  area's top-left.
- Per-site permissions UI for camera, microphone, and geolocation. The
  first time a page asks, a lock button appears next to the ⋮ menu with a
  prompt anchored under it (Allow / Block, both remembered for the
  hostname). The lock turns green and swaps to the open-lock icon while a
  stream or geolocation watch is live in the page, then closes the moment
  the page releases it. Click the lock outside of a prompt for a manage
  panel with Allow / Block / Ask segmented controls per kind. Grants are
  stored per-hostname in `settings.json` under `permissionGrants`.
- HTML5 page-driven fullscreen (YouTube's "expand" button, Vimeo, etc.) now
  takes the host window into real OS fullscreen and hides the toolbar, so
  videos fill the monitor instead of just the webview rect. The existing
  Linux F11 → maximize intercept is gated on a per-window flag, so
  user-driven fullscreen still maximizes-with-chrome as before.
- Screen-share picker for `getDisplayMedia` (Jitsi, Google Meet, Discord,
  …). When a page requests display capture, a modal "Choose what to share"
  picker opens listing screens and application windows with thumbnails
  from `desktopCapturer.getSources`. Esc / Cancel / X deny the request.

### Packaging
- Linux build now produces both `.rpm` and `.deb`. The `.deb` build needs
  `dpkg` and `fakeroot` on the host (`sudo zypper install dpkg fakeroot`
  on openSUSE).
- macOS build target switched from `.zip` to `.dmg`. Must still be run on
  a Mac — electron-builder cannot cross-compile macOS targets from Linux.
- Windows `.exe` (NSIS installer) build was already configured; the
  `build:win` script is documented in `CLAUDE.md`. Linux hosts need
  `wine` installed to produce the `.exe`.

### Changed
- **All windows now share one cookie jar** (`persist:folia`, set as a hard
  HTML attribute on the `<webview>`). Previously each window picked
  `persist:<hostname>` from its initial URL, which meant Google OAuth
  cookies set while logging into Claude lived in a different jar than
  Gmail/YouTube — every Google-auth-needing site forced a fresh login.
  One sign-in to Google now works everywhere. Trade-off: per-site cookie
  isolation is gone (matching Chrome/Firefox default behaviour). Existing
  `persist:<hostname>` data from 1.0 is left on disk but unused; the
  Settings → "Delete cookies/cache" actions still clear it.
- URL bar action label simplified. URLs render as the bare hostname
  ("github.com"); searches render as the quoted query
  ("'why is my child crying?'"). The "visited …" / "searched for …" prefixes
  are gone.
- The search engine setting now also drives the URL bar's search fallback
  (previously hard-coded to DuckDuckGo).
- URL bar default scheme is now context-aware: IPv4 literals and `localhost`
  default to `http://` (so e.g. `10.4.20.88:8080` actually loads instead of
  failing with `ERR_SSL_PROTOCOL_ERROR`), while public hostnames keep
  defaulting to `https://`. Explicit `http://` / `https://` is always
  honoured.
- macOS build icon source switched from `build/icon.icns` to `build/icon.png`.

### Security
- Web Notifications permission is hard-denied for every site. No prompt,
  no per-site override — Folia is intentionally a quiet browser.

### Removed
- `DRM_SETUP.md` (Widevine/Castlabs setup notes now live in `CLAUDE.md` and
  in code comments).

## [1.0.0] — Initial release

Frameless, transparent, single-page Electron browser. No tabs; every popup
gets its own window. Per-site cookie/storage isolation via
`persist:<hostname>` partitions. Widevine via Castlabs ECS. Settings panel
with search engine, DRM toggle, and download configuration.

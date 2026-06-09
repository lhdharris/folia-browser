# Changelog

All notable changes to Folia Browser are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.2] — 2026-06-08

Patch release — bug fixes, macOS polish, and an Electron/Chromium update.

- Bump the bundled Castlabs Electron from `42.0.0+wvcus` to `42.3.3+wvcus`
  so the embedded Chromium reports a current version (some sites were
  warning that the browser was out of date).
- Stop the white-bar flash while a window shrinks to a sticky: the native
  window background is now painted the note colour for the duration of the
  resize, so the compositor never shows browse-mode white as the web buffer
  catches up.
- Keep the mouse cursor visible while shrinking to a sticky on macOS — the
  shrink animation no longer drives Cocoa's native window animator, which
  suppressed the cursor.
- Fix the macOS dock running-dot and the app's menu bar disappearing when
  only sticky windows were left open. Stickies no longer mark themselves as
  full-screen-auxiliary windows on macOS.
- Restore window geometry correctly when leaving HTML5 fullscreen (e.g.
  YouTube) on Linux — the window no longer clings to the top-right corner.
- Remember the last folder used for "Save page as PDF" and default the save
  dialog there next time.
- Stop the app freezing if you pressed Back while a page was being saved as
  PDF: the render is guarded against a closed page and bounded by a timeout.
- Add a footer note to the "Previously closed Folias" menu indicating only
  the 20 most-recent entries are kept.
- Solidify the primary action button (e.g. the screen-picker "Share"
  button), which previously read as washed-out and hard to see.

## [2.1.1] — 2026-05-21

Patch release.

- Fix "Previously closed Folias" submenu always being empty. The
  `did-navigate` / `page-title-updated` listeners in main.js used
  `(e) => e.url` but Electron's signature is `(event, url, ...)` —
  so the per-window `_lastUrl` / `_lastPageTitle` cache that the
  closed-folias entry reads at `win.on('closed')` was never populated.

## [2.1.0] — 2026-05-21

Five sticky-note + window-management improvements.

- Stickies sit below the OS menu bar / taskbar / notification area
  instead of above. `alwaysOnTop` dropped from `screen-saver` to
  `floating` — stickies are desktop post-its, not always-on-top chrome.
- Selecting text on a page and then clicking the sticky button pre-fills
  the sticky comment with the selection.
- Stickies remember the spot the user last dragged them to: drag,
  maximize, re-sticky → returns to the dragged spot. Cleared the moment
  the user moves the full-size window.
- New "Previously closed Folias" submenu in the toolbar dropdown lists
  the 20 most-recent closed windows; re-opening one restores the full
  back-button history, not just the active page.
- Sticky titles show the page's `document.title` rather than the
  origin / search-query label the URL bar uses.

## [2.0.0-beta.3] — Beta 0.3

Sticky-note bug fixes.

- Fix sticky restore being clamped to sticky size on Linux. `setResizable`
  on Linux saves/restores min/max around the call, so calling
  `setResizable(true)` *after* clearing min/max was reinstating the
  sticky-sized constraints — the window animated back to its original
  bounds but the WM held it at 280×200.
- Fix shrink-from-maximized leaving the window in a weird half-maximized
  state until dragged. Now `unmaximize()`s before the shrink animation
  and re-maximizes on restore (state is also persisted, so a maximized
  sticky comes back maximized across relaunches).

## [2.0.0-beta.2] — Beta 0.2

First public beta. Folia Browser is now versioned and distributed as a beta
release; expect rough edges and breaking changes between beta drops.

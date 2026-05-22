# Changelog

All notable changes to Folia Browser are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

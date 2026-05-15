# Changelog

All notable changes to Folia Browser are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

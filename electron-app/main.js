const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, clipboard, components, screen, desktopCapturer, webContents } = require('electron');
const path = require('path');
const fs   = require('fs');
const { pathToFileURL } = require('url');
const { checkForUpdates } = require('./updater');

// macOS menu bar shows the app name in the bold leftmost menu ("About …",
// "Hide …", "Quit …"). Electron derives that from app.getName(), which in dev
// falls back to package.json's `name` ("folia-browser"). Force the pretty
// display name so dev and packaged builds match.
app.setName('Folia Browser');

// Widevine is provided by Castlabs Electron-for-Content (the `electron` dep
// is their VMP-signed fork, see DRM_SETUP.md). The CDM is installed by
// Chromium's Component Updater Service the first time `components.whenReady()`
// resolves — see app.whenReady() below.

// `userData` is `appData/<package.json name>` — i.e. `folia-browser` on every
// platform — so this stays consistent regardless of where Chromium parks
// other state (cookies, the Castlabs Components/CDM cache, etc.).
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// Stickied windows persisted across app restarts. Each entry is enough to
// re-create a lazy sticky on next launch (URL deferred until restore — see
// the "Sticky-window persistence" section below).
const STICKIES_PATH = path.join(app.getPath('userData'), 'stickies.json');
// downloadPath null → use the platform downloads folder (resolved at use-time
// because app.getPath('downloads') is only valid after `app` is constructed).
const SETTINGS_DEFAULTS = {
  searchEngine: 'ecosia',
  drmEnabled: false,
  downloadPath: null,
  askDownloadPath: false,
  zoom: 1,
  // Per-site permission grants. hostname -> true (allow) | false (block).
  // Absence means "ask next time". Notifications are intentionally omitted —
  // the handler hard-denies them regardless of any stored value.
  permissionGrants: { camera: {}, microphone: {}, geolocation: {} },
};

const PERMISSION_KINDS = ['camera', 'microphone', 'geolocation'];

function effectiveDownloadDir() {
  return settings.downloadPath || app.getPath('downloads');
}

function uniqueDownloadPath(dir, filename) {
  let target = path.join(dir, filename);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) i++;
  return path.join(dir, `${base} (${i})${ext}`);
}

let settings = SETTINGS_DEFAULTS;
try {
  settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
} catch {}

function writeSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch {}
}

// Permission grants are nested ({camera: {...}, microphone: {...}, ...}).
// On-disk JSON may be missing some kinds (older settings.json, or only one
// kind has ever been touched), so accessors normalise on read/write.
function getGrant(kind, hostname) {
  return settings.permissionGrants?.[kind]?.[hostname];
}

function setGrant(kind, hostname, value) {
  if (!settings.permissionGrants) settings.permissionGrants = {};
  if (!settings.permissionGrants[kind]) settings.permissionGrants[kind] = {};
  if (value === null || value === undefined) {
    delete settings.permissionGrants[kind][hostname];
  } else {
    settings.permissionGrants[kind][hostname] = !!value;
  }
  writeSettings();
}

function getGrantsForHost(hostname) {
  const out = {};
  for (const k of PERMISSION_KINDS) out[k] = getGrant(k, hostname);
  return out;
}

// Pending camera/mic/location prompts awaiting a renderer response.
// id -> { callback, kinds[], hostname }. Callback is the Electron permission
// handler's callback; we resolve it once with allow/deny when the user acts.
const pendingPermissionRequests = new Map();
let nextPermissionId = 0;

function findOwningWindow(guestWebContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w._guest === guestWebContents) return w;
  }
  return null;
}

// "Only stickies are open" — used by the launch paths (cold start, macOS
// activate) to decide whether activating the app needs a fresh blank window.
// A parked sticky can't load a URL until it's restored, so without this check
// the user can have the app running and no way to actually browse.
function onlyStickyWindowsOpen() {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 && wins.every((w) => w._sticky);
}

// Per-window pastel hue assignment. Each window with a known hostname gets a
// slot in `windowHues`; the renderer paints its toolbar with `hsl(hue, …)`.
// Assignment is sticky — once a window has a hue, it keeps it until close —
// so users can rely on "the blue one" staying blue. A new window prefers the
// hash of its hostname (same site → same colour), but if that's too close to
// any open window's existing hue it slides into the largest gap on the wheel.
// Single-window case clears the hue so a lone window stays default grey.
//
// `lockedColor` overrides the hue → hsl pipeline with a literal CSS colour
// (e.g. `#FFFFE0` for a sticky-noted lone window). Once set, recomputeHues
// leaves the entry alone forever (the colour is sticky like an assigned hue),
// and the renderer applies the literal string to `--toolbar-bg` instead of
// the hsl(hue, …) formula.
const windowHues = new Map();  // winId -> { hostname, hue: number|null, lockedColor: string|null }
const HUE_SPACING_FACTOR = 0.7;

// Sticky-note minimize. Replacing the OS-level minimize, the sticky button
// shrinks the BrowserWindow into a small on-desktop "post-it" carrying the
// window's action label + an editable comment. Real OS resize, animated
// from current bounds → STICKY_BASE_W×STICKY_BASE_H × settings.zoom,
// anchored at the current top-left.
const STICKY_BASE_W = 280;
const STICKY_BASE_H = 200;
const STICKY_LOCK_COLOR = '#FFFFE0';
const STICKY_ANIM_MS = 260;

function stickyBoundsFor(cur) {
  const zoom = settings.zoom || 1;
  return {
    x: cur.x,
    y: cur.y,
    width:  Math.round(STICKY_BASE_W * zoom),
    height: Math.round(STICKY_BASE_H * zoom),
  };
}

// Wayland alwaysOnTop is best-effort: compositors honour the level hint
// in different ways, and some reset it on bounds changes. Belt-and-braces:
// 'screen-saver' (highest level) + setVisibleOnAllWorkspaces, applied
// before AND after the bounds animation so the WM picks it up regardless
// of which order it processes the events.
function pinStickyOnTop(win) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {}
}

function unpinStickyOnTop(win) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  try { win.setVisibleOnAllWorkspaces(false); } catch {}
}

// Fix the sticky's size so neither the user nor the WM's title-bar gesture
// can resize it. Two platform paths because the gestures we're defending
// against live at different layers:
//   - Linux/Windows: the WM reads min == max as "fixed-size" and (on
//     Wayland especially) suppresses dblclick-to-maximize at the compositor.
//     setResizable(false) doesn't carry the same signal — Mutter still
//     fires the maximize-state-flag on dblclick — so min/max is the lever
//     for gesture defense. setResizable(false) is *also* applied, but for
//     a different reason: Chromium's frameless-window code draws its own
//     edge resize hover cursors (↔ ↕ ⤡) keyed off the resizable flag, not
//     off the min/max constraints, so without it the cursor still implies
//     "drag me to resize" even though min == max blocks the actual resize.
//   - macOS: setMinimumSize/setMaximumSize would clamp the size correctly,
//     but Cocoa's NSWindow.zoom() (the title-bar dblclick gesture)
//     computes a "standard frame" by clamping the screen visibleFrame
//     to contentMaxSize and snapping the origin to the visibleFrame's
//     bottom-left (macOS coords are bottom-left origin). Result: dblclick
//     teleports the sticky to the bottom-left corner of the screen at
//     sticky size and "maximize" doesn't fire reliably, so the post-hoc
//     restore listener never runs. setResizable(false) is documented to
//     make NSWindow.zoom a no-op (Apple: "If a window's style mask
//     doesn't include NSWindowStyleMaskResizable, the title bar isn't
//     double-clickable and zoom isn't called"), which disables the
//     gesture at the source. Programmatic setBounds still works, so the
//     shrink/restore animations are unaffected.
function lockStickySize(win, w, h) {
  if (win.isDestroyed()) return;
  if (process.platform === 'darwin') {
    win.setResizable(false);
  } else {
    win.setMinimumSize(w, h);
    win.setMaximumSize(w, h);
    win.setResizable(false);
  }
}

function unlockStickySize(win) {
  if (win.isDestroyed()) return;
  if (process.platform === 'darwin') {
    win.setResizable(true);
  } else {
    win.setMinimumSize(0, 0);
    win.setMaximumSize(0, 0);
    win.setResizable(true);
  }
}

function hostnameHue(hostname) {
  let h = 5381;
  for (let i = 0; i < hostname.length; i++) {
    h = ((h << 5) + h + hostname.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function assignHue(preferred, others) {
  if (others.length === 0) return preferred;
  const required = (360 / (others.length + 1)) * HUE_SPACING_FACTOR;
  const minDist = Math.min(...others.map((h) => hueDistance(preferred, h)));
  if (minDist >= required) return preferred;
  const sorted = [...others].sort((a, b) => a - b);
  let bestGap = 0;
  let bestMid = preferred;
  for (let i = 0; i < sorted.length; i++) {
    const isLast = i === sorted.length - 1;
    const next = isLast ? sorted[0] + 360 : sorted[i + 1];
    const gap = next - sorted[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (sorted[i] + gap / 2) % 360;
    }
  }
  return bestMid;
}

// CSS colour string for an entry, or null if the window should be untinted.
// lockedColor wins when present (sticky-note frozen colour); otherwise hue
// is converted to the toolbar's pastel hsl. Renderer applies whatever this
// returns directly to `--toolbar-bg`.
function colorForEntry(info) {
  if (info.lockedColor) return info.lockedColor;
  if (info.hue !== null) return `hsl(${info.hue}, 50%, 90%)`;
  return null;
}

function sendColorToWindow(winId, color) {
  const w = BrowserWindow.fromId(winId);
  if (w && !w.isDestroyed()) w.webContents.send('window-color', color);
}

function recomputeHues() {
  const entries = [...windowHues.entries()];
  const shouldTint = entries.length >= 2;

  if (!shouldTint) {
    // Solo window: drop any pastel hue. lockedColor entries (e.g. sticky-yellow)
    // are left intact — that's the whole point of the lock, and the renderer
    // keeps painting the locked colour.
    for (const [id, info] of entries) {
      if (info.lockedColor) continue;
      if (info.hue !== null) {
        info.hue = null;
        sendColorToWindow(id, null);
      }
    }
    return;
  }

  // Sticky: keep existing assignments, only fill null slots (insertion order).
  // lockedColor entries are also "assigned" in the sense that they don't need
  // a hue — they're skipped here. Their colour doesn't participate in pastel
  // spacing (the locked colours aren't on the pastel wheel).
  const assigned = entries.map(([, info]) => info.hue).filter((h) => h !== null);
  for (const [id, info] of entries) {
    if (info.lockedColor) continue;
    if (info.hue !== null) continue;
    const preferred = hostnameHue(info.hostname);
    const hue = assignHue(preferred, assigned);
    info.hue = hue;
    assigned.push(hue);
    sendColorToWindow(id, colorForEntry(info));
  }
}

function registerWindowHostname(win, hostname) {
  if (!hostname || windowHues.has(win.id)) return;
  windowHues.set(win.id, { hostname, hue: null, lockedColor: null });
  recomputeHues();
}

function unregisterWindow(winId) {
  if (windowHues.delete(winId)) recomputeHues();
}

// Cascade: a new window inherits the opener's size and is offset by this many
// pixels down-and-right. If the offset would push the new window off the work
// area, wrap back to the opener's own origin. If the opener is larger than
// the work area (e.g. maximized), match the work area minus a frame of the
// same offset and start at work-area origin + offset.
const CASCADE_OFFSET = 32;

// `opener` may be in sticky-note mode; its current bounds would be the tiny
// sticky rect. We want the new window to cascade off the *pre-shrink* size,
// otherwise children inherit the postage-stamp dimensions.
function cascadedBoundsFrom(opener) {
  if (!opener || opener.isDestroyed()) return null;
  const o = opener._sticky?.originalBounds || opener.getBounds();
  const work = screen.getDisplayMatching(o).workArea;

  const maxW = work.width  - 2 * CASCADE_OFFSET;
  const maxH = work.height - 2 * CASCADE_OFFSET;
  if (o.width > maxW || o.height > maxH) {
    return {
      x: work.x + CASCADE_OFFSET,
      y: work.y + CASCADE_OFFSET,
      width:  Math.min(o.width,  maxW),
      height: Math.min(o.height, maxH),
    };
  }

  let x = o.x + CASCADE_OFFSET;
  let y = o.y + CASCADE_OFFSET;
  if (x + o.width  > work.x + work.width ||
      y + o.height > work.y + work.height) {
    x = o.x;
    y = o.y;
  }
  return { x, y, width: o.width, height: o.height };
}

// Animated bounds change, cross-platform. macOS exposes a native animated
// setBounds via the second arg (Cocoa NSWindow animator) — way smoother
// than any JS-driven loop. Linux and Windows ignore that flag, so for
// those we interpolate in main with setTimeout ticks + easeOutCubic.
//
// Tick interval is 30ms (~33fps), not 16ms (~60fps), on purpose: each
// setBounds triggers a full Wayland configure → Chromium repaint at the
// new size, often >20ms. Tighter ticks queue faster than the compositor
// can drain → visible chop. 30ms gives breathing room on Mutter / KWin
// Wayland.
//
// Easing is easeOutCubic — fast start, gentle settle. Picked over the
// symmetric easeInOutQuad because the tick floor only gives us ~8-9 frames
// for a sub-300ms animation. easeOutCubic puts the small per-frame deltas
// at the end where they look like smooth deceleration, and the big deltas
// at the start where they're masked by motion (each big-delta frame is
// only on screen for one tick before the next one paints over it). The
// symmetric curve put the biggest deltas in the middle where they read
// as discrete jumps. Returns a promise that resolves after `ms` so
// callers can sequence post-animation work (e.g. focusing the sticky
// comment area).
const ANIM_TICK_MS = 30;

function animateBounds(win, target, ms) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve();
    if (process.platform === 'darwin') {
      // Native macOS animation. No completion callback exposed by Electron,
      // so resolve after the requested duration — close enough for the
      // renderer's "focus comment after shrink" sequencing.
      win.setBounds(target, true);
      setTimeout(resolve, ms);
      return;
    }
    const start = win.getBounds();
    const t0 = Date.now();
    const tick = () => {
      if (win.isDestroyed()) return resolve();
      const elapsed = Date.now() - t0;
      const t = Math.min(1, elapsed / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      win.setBounds({
        x:      Math.round(start.x      + (target.x      - start.x)      * eased),
        y:      Math.round(start.y      + (target.y      - start.y)      * eased),
        width:  Math.round(start.width  + (target.width  - start.width)  * eased),
        height: Math.round(start.height + (target.height - start.height) * eased),
      });
      if (t < 1) setTimeout(tick, ANIM_TICK_MS);
      else resolve();
    };
    tick();
  });
}

// ---- Sticky-window persistence ----------------------------------------
// On every relevant change (shrink, restore, comment edit, drag, close)
// we snapshot the currently-stickied windows to STICKIES_PATH (debounced
// ~200ms). On launch, each saved entry is re-created as a *lazy* sticky:
// the BrowserWindow opens at the saved sticky bounds with sticky-mode
// already applied, but the webview's `src` is never set so no guest
// process spawns. The URL is stored as `deferredUrl` on `_sticky` and
// loaded by the renderer (via the existing startLoad path) only when the
// user maximises the sticky — Chrome-style tab restore.

let writeStickiesTimer = null;
function scheduleSaveStickies() {
  if (writeStickiesTimer) return;
  writeStickiesTimer = setTimeout(() => {
    writeStickiesTimer = null;
    saveStickiesNow();
  }, 200);
}

function flushSaveStickies() {
  if (writeStickiesTimer) {
    clearTimeout(writeStickiesTimer);
    writeStickiesTimer = null;
  }
  saveStickiesNow();
}

function saveStickiesNow() {
  const entries = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w._sticky) continue;
    const info = windowHues.get(w.id);
    entries.push({
      url:            w._sticky.url     || null,
      verb:           w._sticky.verb    || null,
      label:          w._sticky.label   || null,
      comment:        w._sticky.comment || '',
      originalBounds: w._sticky.originalBounds,
      stickyBounds:   w._sticky.stickyBounds,
      lockedColor:    info?.lockedColor || null,
      hostname:       info?.hostname    || null,
    });
  }
  try {
    fs.mkdirSync(path.dirname(STICKIES_PATH), { recursive: true });
    fs.writeFileSync(STICKIES_PATH, JSON.stringify(entries, null, 2));
  } catch {}
}

function loadStickiesFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(STICKIES_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// Saved bounds may be off-screen if the user disconnected a monitor between
// quit and launch. Pull the rect into the nearest display's work area so the
// restored sticky is always visible and clickable.
function clampBoundsToDisplay(bounds) {
  const work = screen.getDisplayMatching(bounds).workArea;
  const width  = Math.min(bounds.width,  work.width);
  const height = Math.min(bounds.height, work.height);
  return {
    x: Math.max(work.x, Math.min(work.x + work.width  - width,  bounds.x)),
    y: Math.max(work.y, Math.min(work.y + work.height - height, bounds.y)),
    width,
    height,
  };
}

// Whether `host` (the part before any path; may include :port) is a numeric
// IP or localhost. Used to pick the default scheme: local/IP services almost
// always speak plain HTTP (e.g. the Supernote screen-mirror at 10.4.20.88:8080),
// while public hostnames default to HTTPS.
function isLocalHost(host) {
  const noPort = host.split(':')[0];
  if (noPort === 'localhost') return true;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(noPort);
}

function resolveUrl(arg) {
  if (!arg || arg.startsWith('-')) return searchUrl(arg || '');
  if (arg.startsWith('file://')) return arg;
  if (arg.startsWith('http://') || arg.startsWith('https://')) return arg;
  // OS file-association handoff: when the user clicks an .html file the OS
  // hands us an absolute filesystem path, not a URL. Only treat it as a file
  // if it actually exists — otherwise typos like "folder.name" would match
  // path.isAbsolute on POSIX and get forced to file:// instead of searching.
  if (path.isAbsolute(arg)) {
    try {
      if (fs.statSync(arg).isFile()) return pathToFileURL(arg).href;
    } catch {}
  }
  if (!arg.includes(' ') && arg.includes('.')) {
    const host = arg.split('/')[0];
    return (isLocalHost(host) ? 'http://' : 'https://') + arg;
  }
  return searchUrl(arg);
}

function searchUrl(query) {
  const q = encodeURIComponent(query);
  switch (settings.searchEngine) {
    case 'duckduckgo': return 'https://duckduckgo.com/?q=' + q;
    case 'google':     return 'https://www.google.com/search?q=' + q;
    case 'bing':       return 'https://www.bing.com/search?q=' + q;
    default:           return 'https://www.ecosia.org/search?q=' + q;
  }
}

function pickUrlArg(argv, start) {
  return argv.slice(start).find(a => !a.startsWith('-'));
}

// `opener`: the BrowserWindow this navigation came from (target="_blank",
// context-menu "Open in new window", the ⋮ menu's "New window", etc.). Used
// to cascade the new window's bounds. When omitted, we fall back to whichever
// window is focused at the moment — that covers second-instance launches and
// macOS protocol clicks. If nothing is focused (startup, dock activate after
// all windows closed), the new window gets Electron's default placement.
function createWindow(url, opener, options = {}) {
  // `restoreSticky`: a saved entry from stickies.json. When set, the window
  // opens directly into sticky-mode at the saved bounds with no URL loaded —
  // the renderer queries get-init-state, paints the overlay, and only loads
  // the deferred URL once the user maximises.
  const restore = options.restoreSticky;
  const initialBounds = restore
    ? clampBoundsToDisplay(restore.stickyBounds)
    : (cascadedBoundsFrom(opener || BrowserWindow.getFocusedWindow())
       || { width: 1200, height: 800 });

  const win = new BrowserWindow({
    width:  initialBounds.width,
    height: initialBounds.height,
    ...(initialBounds.x !== undefined ? { x: initialBounds.x, y: initialBounds.y } : {}),
    frame: false,
    backgroundColor: '#ffffff',
    resizable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'folia-icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  if (restore) {
    // Mirror everything wm-sticky-shrink does at runtime: _sticky state for
    // size-restore + persistence, hue/lockedColor registration so the toolbar
    // paints the saved colour the moment it's revealed, always-on-top pin,
    // and the fixed-size clamp that prevents WM dblclick-to-maximise from
    // resizing the window. `deferredUrl` is the lazy-load signal — the
    // restore IPC returns it once and the renderer calls startLoad with it.
    win._sticky = {
      originalBounds: restore.originalBounds,
      stickyBounds:   initialBounds,
      url:            restore.url,
      verb:           restore.verb,
      label:          restore.label,
      comment:        restore.comment || '',
      deferredUrl:    restore.url,
      lazy:           true,
    };
    if (restore.hostname) {
      windowHues.set(win.id, {
        hostname:    restore.hostname,
        hue:         null,
        lockedColor: restore.lockedColor || null,
      });
      recomputeHues();
    }
    pinStickyOnTop(win);
    lockStickySize(win, initialBounds.width, initialBounds.height);
  }

  // Empty hash → renderer shows the search bar and waits for input. For a
  // lazy-restored sticky the renderer queries get-init-state instead and
  // shows the sticky overlay without loading any URL.
  const hash = restore ? '' : (url ? '#' + encodeURIComponent(url) : '');
  win.loadURL('file://' + path.join(__dirname, 'renderer', 'index.html') + hash);

  win.webContents.on('did-attach-webview', (_, wvContents) => {
    // Store the guest webContents so the toolbar dropdown (built in main)
    // can act on it (Copy URL, Refresh, Print to PDF, zoom).
    win._guest = wvContents;

    // Apply the global zoom on every load. setZoomFactor can be reset on
    // cross-origin navigation, so re-applying on dom-ready keeps it stable.
    wvContents.on('dom-ready', () => {
      try { wvContents.setZoomFactor(settings.zoom || 1); } catch {}
    });

    // Audio state — used by the sticky-note speaker indicator. Fires only
    // when the audible state actually changes (silent video doesn't trip
    // it; muted-then-unmuted audio does), which is exactly what the user
    // wants on a parked sticky.
    wvContents.on('audio-state-changed', (event) => {
      if (win.isDestroyed()) return;
      win.webContents.send('audio-state', !!event.audible);
    });

    // getDisplayMedia (screen sharing). Chromium rejects this by default in
    // Electron — without a handler, sites like the Ratta Supernote mirror
    // never see a stream. Handler is per-session; persistent partitions
    // dedupe via __foliaDcAttached.
    attachDisplayMediaHandler(wvContents.session);

    // HTML5 fullscreen (YouTube's "expand" button, vimeo, etc.) is requested
    // by the page via element.requestFullscreen(). By default Chromium just
    // sizes the fullscreen element to the <webview>'s rect, which leaves the
    // toolbar visible and caps the video at the window's content area. Take
    // the host BrowserWindow into real OS fullscreen so the video fills the
    // monitor, and tell the renderer to hide the toolbar.
    //
    // The Linux 'enter-full-screen' intercept below normally reverts real
    // fullscreen back to maximize (to preserve the chrome). _htmlFullscreen
    // gates it so HTML fullscreen requests pass through unscathed.
    wvContents.on('enter-html-full-screen', () => {
      win._htmlFullscreen = true;
      if (!win.isFullScreen()) win.setFullScreen(true);
      win.webContents.send('html-fullscreen', true);
    });
    wvContents.on('leave-html-full-screen', () => {
      win._htmlFullscreen = false;
      if (win.isFullScreen()) win.setFullScreen(false);
      win.webContents.send('html-fullscreen', false);
    });

    wvContents.setWindowOpenHandler(({ url: newUrl, disposition }) => {
      // Two cases:
      //
      // 1) `new-window` — window.open(url, name, "width=…,height=…").
      //    OAuth popups depend on this: the popup needs to be a real child of
      //    the opener so window.opener.postMessage and window.close work for
      //    the auth round-trip. Allow Chromium to make a popup, just with our
      //    icon and a hidden menu bar. The OS frame stays — it's how popups
      //    look in every browser.
      //
      // 2) everything else — target="_blank" links, plain window.open(url),
      //    middle-click. These get the full Folia shell (toolbar,
      //    frameless rounded window, per-site partition assigned in the
      //    renderer) by routing through the same createWindow() the menu's
      //    "New window" uses. Deny the bare popup so we don't get a duplicate.
      //
      // save-to-disk is denied; downloads come through session.on('will-download').
      if (disposition === 'save-to-disk') return { action: 'deny' };
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            icon: path.join(__dirname, 'renderer', 'folia-icon.svg'),
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      createWindow(newUrl, win);
      return { action: 'deny' };
    });

    // Permission handler. Three buckets:
    //  - DRM (`media-key-system-access`): gated on the DRM settings toggle.
    //  - Notifications: hard-denied. Folia is intentionally a quiet browser;
    //    no per-site override or UI for this.
    //  - Camera / mic / location: per-hostname grants stored in settings.
    //    First request prompts via the toolbar's lock UI; subsequent visits
    //    auto-allow or auto-block based on the stored decision.
    //  - Everything else (clipboard-read, midi, usb, …): allow, matching
    //    the pre-permissions-UI behaviour. If we ever start prompting for
    //    these too, add them to PERMISSION_KINDS rather than here.
    //
    // Dedup: every window shares the `persist:folia` session, so without
    // the flag this handler would be reinstalled on every webview attach.
    if (!wvContents.session.__foliaPermAttached) {
      wvContents.session.__foliaPermAttached = true;
      wvContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (permission === 'media-key-system-access') {
          return callback(settings.drmEnabled === true);
        }
        if (permission === 'notifications') return callback(false);

        const kinds = [];
        if (permission === 'media') {
          const types = details?.mediaTypes || [];
          if (types.includes('video')) kinds.push('camera');
          if (types.includes('audio')) kinds.push('microphone');
        } else if (permission === 'geolocation') {
          kinds.push('geolocation');
        }
        if (kinds.length === 0) return callback(true);

        let hostname = '';
        try { hostname = new URL(details?.requestingUrl || wc.getURL()).hostname; } catch {}
        if (!hostname) return callback(false);

        // If every requested kind already has a stored decision, honour it
        // without prompting. "Allow only if all kinds are allowed" — a single
        // 'block' on either part of a combined camera+mic request denies both.
        const decisions = kinds.map((k) => getGrant(k, hostname));
        if (decisions.every((d) => d !== undefined)) {
          return callback(decisions.every((d) => d === true));
        }

        const parentWin = findOwningWindow(wc);
        if (!parentWin) return callback(false);

        const id = ++nextPermissionId;
        pendingPermissionRequests.set(id, { callback, kinds, hostname, parentWinId: parentWin.id });
        parentWin.webContents.send('permission-request', { id, kinds, hostname });
      });
    }

    // Right-click menu inside web content. Chromium fires `context-menu` with
    // params describing what was clicked; we build a template from those.
    wvContents.on('context-menu', (_e, params) => {
      const template = [];

      if (params.linkURL) {
        template.push(
          { label: 'Open link in new window', click: () => createWindow(params.linkURL, win) },
          { label: 'Copy link address',       click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' },
        );
      }

      const ef = params.editFlags || {};
      const selText = (params.selectionText || '').replace(/\s+/g, ' ').trim();
      const searchItem = selText && {
        label: `Search '${selText.length > 30 ? selText.slice(0, 30) + '…' : selText}' in new window`,
        click: () => createWindow(searchUrl(selText), win),
      };

      if (params.isEditable) {
        template.push(
          { label: 'Cut',        accelerator: 'CmdOrCtrl+X', enabled: ef.canCut,       click: () => wvContents.cut() },
          { label: 'Copy',       accelerator: 'CmdOrCtrl+C', enabled: ef.canCopy,      click: () => wvContents.copy() },
          { label: 'Paste',      accelerator: 'CmdOrCtrl+V', enabled: ef.canPaste,     click: () => wvContents.paste() },
          { label: 'Select all', accelerator: 'CmdOrCtrl+A', enabled: ef.canSelectAll, click: () => wvContents.selectAll() },
        );
        if (searchItem) template.push({ type: 'separator' }, searchItem);
      } else if (selText) {
        template.push(
          { label: 'Copy',       accelerator: 'CmdOrCtrl+C', enabled: ef.canCopy,      click: () => wvContents.copy() },
          { label: 'Select all', accelerator: 'CmdOrCtrl+A', enabled: ef.canSelectAll, click: () => wvContents.selectAll() },
          { type: 'separator' },
          searchItem,
        );
      }

      while (template.length && template[template.length - 1].type === 'separator') {
        template.pop();
      }
      if (!template.length) return;

      Menu.buildFromTemplate(template).popup({ window: win });
    });
  });

  // Linux-only: intercept user-driven fullscreen (F11) → maximize so the
  // window border stays visible. macOS users expect Cmd+Ctrl+F native
  // fullscreen; Windows doesn't need this either. _htmlFullscreen lets
  // page-requested fullscreen (YouTube etc.) bypass the revert so videos
  // can actually fill the monitor.
  if (process.platform === 'linux') {
    win.on('enter-full-screen', () => {
      if (win._htmlFullscreen) return;
      win.setFullScreen(false);
      win.maximize();
    });
  }

  // Sticky-note windows can't be made truly maximize-inert on GNOME
  // Wayland — Mutter handles the dblclick gesture before any JS can
  // preventDefault, and the post-hoc options are all visibly broken:
  //   - `unmaximize()` alone shaves a pixel off the size each cycle
  //     (a Wayland configure-event race between min=max and the state
  //     transition); the "shrinks once on dblclick" bug.
  //   - Doing nothing leaves the window stuck in the top-left corner
  //     where Mutter moved it as part of the maximize gesture.
  //   - `unmaximize() + setBounds(stickyBounds)` accumulates shrink each
  //     cycle (the original "shrinks to nothing" bug).
  // Instead, repurpose the gesture: dblclicking a sticky restores it.
  // The user can't actually maximize a sticky, so dblclick → restore is
  // a natural UX, and the upcoming animateBounds in the restore handler
  // wipes any size drift the unmaximize introduces.
  win.on('maximize', () => {
    if (!win._sticky) return;
    win.unmaximize();
    win.webContents.send('sticky-restore-requested');
  });

  // Stickies persistence: every drag of a parked sticky updates its saved
  // position so the next launch puts it back exactly where the user left it.
  // `move` fires throughout the drag on Linux/Windows; `moved` fires once at
  // the end on macOS — debounce dedupes both. Guard on _sticky so non-sticky
  // window moves don't hammer the disk.
  //
  // `trackMoves` is gated on `show` + 250ms settle: on Wayland the
  // compositor ignores our initial x/y hints and places the window where
  // it wants, firing `move` events as it does so. Without this gate, the
  // WM-placed position would immediately overwrite the saved bounds for
  // every lazy-restored sticky. After the window settles, only real user
  // drags fire the listener.
  let trackMoves = false;
  win.once('show', () => {
    setTimeout(() => { trackMoves = true; }, 250);
  });
  const trackStickyMove = () => {
    if (!trackMoves) return;
    if (win.isDestroyed() || !win._sticky) return;
    const b = win.getBounds();
    win._sticky.stickyBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    scheduleSaveStickies();
  };
  win.on('move', trackStickyMove);
  win.on('moved', trackStickyMove);

  win.on('closed', () => {
    unregisterWindow(win.id);
    // Resolve any in-flight permission prompts for this window as denials —
    // otherwise the guest's getUserMedia/getCurrentPosition promise hangs
    // forever (the callback never fires) and the page leaks the request.
    for (const [id, req] of pendingPermissionRequests) {
      if (req.parentWinId !== win.id) continue;
      pendingPermissionRequests.delete(id);
      try { req.callback(false); } catch {}
    }
    // Drop this window from the persisted stickies snapshot. No-op if it
    // wasn't a sticky; if it was, the snapshot now excludes it because
    // saveStickiesNow iterates the live BrowserWindow list.
    scheduleSaveStickies();
  });
}

// ---- Screen sharing (getDisplayMedia) -----------------------------------
// Chromium ≥ 105 rejects getDisplayMedia in Electron unless the session
// supplies a setDisplayMediaRequestHandler. We hang our own picker off of
// it: enumerate desktopCapturer sources, show a modal BrowserWindow with
// thumbnails, and resolve the request with the chosen source.
//
// Sources fetched by the picker are kept in pickerSources keyed by the
// picker's webContents id, so the result handler can match the picked id
// back to a real DesktopCapturerSource without re-enumerating.
const pickerSources = new Map();  // picker webContents id -> DesktopCapturerSource[]

function serializeSource(s) {
  return {
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  };
}

ipcMain.handle('screen-picker-get-sources', async (e) => {
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
  } catch {
    return [];
  }
  pickerSources.set(e.sender.id, sources);
  return sources.map(serializeSource);
});

function showScreenPicker(parentWin) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 720,
      height: 540,
      parent: parentWin,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      backgroundColor: '#ffffff',
      icon: path.join(__dirname, 'renderer', 'folia-icon.svg'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    picker.loadURL('file://' + path.join(__dirname, 'renderer', 'screen-picker.html'));

    let resolved = false;
    const finish = (source) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('screen-picker-result', resultHandler);
      pickerSources.delete(picker.webContents.id);
      if (!picker.isDestroyed()) picker.close();
      resolve(source || null);
    };
    const resultHandler = (e, sourceId) => {
      if (e.sender !== picker.webContents) return;
      if (!sourceId) return finish(null);
      const sources = pickerSources.get(picker.webContents.id) || [];
      finish(sources.find((s) => s.id === sourceId) || null);
    };
    ipcMain.on('screen-picker-result', resultHandler);
    picker.on('closed', () => finish(null));
  });
}

function attachDisplayMediaHandler(sess) {
  if (sess.__foliaDcAttached) return;
  sess.__foliaDcAttached = true;
  sess.setDisplayMediaRequestHandler(async (request, callback) => {
    let parentWin = null;
    try {
      const guestWc = webContents.fromFrame(request.frame);
      if (guestWc) parentWin = findOwningWindow(guestWc);
    } catch {}
    if (!parentWin) parentWin = BrowserWindow.getFocusedWindow();
    if (!parentWin) return callback();

    const source = await showScreenPicker(parentWin);
    if (!source) return callback();
    callback({ video: source });
  });
}

let settingsWin = null;

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 580,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#ffffff',
    parent: BrowserWindow.getFocusedWindow() || undefined,
    icon: path.join(__dirname, 'renderer', 'folia-icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  settingsWin.loadURL('file://' + path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

async function eachSession() {
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions');
  const sessions = [session.defaultSession];
  try {
    const dirs = await fs.promises.readdir(partitionsDir);
    for (const name of dirs) sessions.push(session.fromPartition('persist:' + name));
  } catch {}
  return sessions;
}

let downloadCounter = 0;

// One-shot owner hint for downloads started from the main process (the
// updater, currently). will-download fires with `wc` set to the session's
// own webContents, not a guest, so findOwningWindow returns null. The
// updater calls setPendingDownloadOwner(win) right before downloadURL so
// the next will-download event can attribute progress to that window's UI.
let pendingDownloadOwner = null;
function setPendingDownloadOwner(win) {
  pendingDownloadOwner = win && !win.isDestroyed() ? win : null;
}

function attachDownloadHandler(sess) {
  if (sess.__foliaDlAttached) return;
  sess.__foliaDlAttached = true;
  sess.on('will-download', (_event, item, wc) => {
    const id = ++downloadCounter;
    const filename = item.getFilename();

    // Route every event for this item to the one window whose webview started
    // the download — not broadcast to every open window. `wc` is the guest
    // webContents; findOwningWindow maps it back via the `_guest` slot. If the
    // owner has already closed by the time an event fires (e.g. download
    // started, user closed the window, then it finished), the event is just
    // dropped — the file still saves, no UI gets updated.
    let ownerWin = findOwningWindow(wc);
    if (!ownerWin && pendingDownloadOwner && !pendingDownloadOwner.isDestroyed()) {
      ownerWin = pendingDownloadOwner;
      pendingDownloadOwner = null;
    }
    const sendToOwner = (payload) => {
      if (ownerWin && !ownerWin.isDestroyed()) {
        ownerWin.webContents.send('download-event', payload);
      }
    };

    if (!settings.askDownloadPath) {
      const target = uniqueDownloadPath(effectiveDownloadDir(), filename);
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      item.setSavePath(target);
    }
    // else: leave savePath unset → Electron shows the native save dialog.

    sendToOwner({ kind: 'started', id, filename });

    item.on('updated', (_e, state) => {
      if (state === 'progressing') {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        const progress = total > 0 ? received / total : 0;
        sendToOwner({ kind: 'progress', id, progress, paused: item.isPaused() });
      }
    });

    item.on('done', (_e, state) => {
      if (state === 'completed') {
        sendToOwner({ kind: 'done', id, filename, savePath: item.getSavePath() });
      } else {
        sendToOwner({ kind: 'failed', id, state });
      }
    });
  });
}

// IPC: window controls. Note: there's no `wm-minimize` — the toolbar's old
// minimize button has been replaced with the sticky-note shrink (below),
// which collapses the window into a small on-desktop note instead of
// hiding it to the taskbar.
ipcMain.on('wm-close',    (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('wm-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

// IPC: sticky-note minimize. Shrink resolves once the bounds animation
// finishes so the renderer can sequence "focus the comment area" after.
// Restore mirrors. New-window-from-sticky cascades off the *original*
// (pre-shrink) bounds — see cascadedBoundsFrom's _sticky branch.
ipcMain.handle('wm-sticky-shrink', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win._sticky) return;
  const originalBounds = win.getBounds();
  const stickyBounds = stickyBoundsFor(originalBounds);
  // stickyBounds is stored so the maximize-intercept handler can reset to
  // the exact target size. On Wayland, repeated unmaximize() calls drift
  // by a few pixels each cycle (compositor frame inset accounting), which
  // caused the "smaller and smaller" sticky bug on dblclick-to-maximize.
  // url/verb/label/comment come from the renderer so the persistence layer
  // can rehydrate the sticky on next launch with its title and pending URL.
  win._sticky = {
    originalBounds,
    stickyBounds,
    url:     payload.url     || null,
    verb:    payload.verb    || null,
    label:   payload.label   || null,
    comment: payload.comment || '',
  };

  // Lone window with no hue → freeze its colour to the sticky-yellow so it
  // stays yellow forever (consistent with how assigned hues are sticky).
  // recomputeHues skips lockedColor entries, and sendColorToWindow paints
  // the literal string.
  const info = windowHues.get(win.id);
  if (info && info.hue === null && !info.lockedColor) {
    info.lockedColor = STICKY_LOCK_COLOR;
    sendColorToWindow(win.id, STICKY_LOCK_COLOR);
  }

  // Float above other windows so the user doesn't lose track of parked
  // notes when working in another window. Pin before AND after the
  // resize — see pinStickyOnTop for why.
  pinStickyOnTop(win);

  await animateBounds(win, stickyBounds, STICKY_ANIM_MS);

  pinStickyOnTop(win);

  // Lock the size after the animation so neither the user nor the WM's
  // dblclick-to-maximize gesture can resize the sticky. lockStickySize
  // picks the right lever per platform — see its docs for the full
  // pathology (Wayland needs min==max as a fixed-size hint to the
  // compositor; macOS needs setResizable(false) so Cocoa's zoom: doesn't
  // teleport the sticky to the screen's bottom-left corner).
  lockStickySize(win, stickyBounds.width, stickyBounds.height);

  scheduleSaveStickies();
});

ipcMain.handle('wm-sticky-restore', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !win._sticky) return { deferredUrl: null };
  const target = win._sticky.originalBounds;
  // Lazy-restored stickies carry deferredUrl so the renderer can call
  // startLoad after the animation grows the window back to full size
  // (setting src on a still-shrunken webview triggers the layout-too-small
  // bug guarded by the comment in renderer/toolbar.js).
  const deferredUrl = win._sticky.deferredUrl || null;
  win._sticky = null;
  unpinStickyOnTop(win);

  // Unlock the size before animating back up — the shrink handler locked
  // it (min/max on Linux/Windows; resizable=false on macOS) to disable
  // dblclick-maximize.
  unlockStickySize(win);

  // Restore-to-grey: if this window is alone (no siblings), drop the
  // sticky-yellow lock so the toolbar reverts to default. If there are
  // siblings, keep the lock — yellow stays yellow alongside coloured
  // siblings (matches the original "yellow stays yellow" rule).
  const info = windowHues.get(win.id);
  if (info?.lockedColor && BrowserWindow.getAllWindows().length === 1) {
    info.lockedColor = null;
    info.hue = null;
    // Broadcast directly: recomputeHues' "no tint" branch only sends when
    // hue actually changed, so a null→null transition wouldn't fire.
    sendColorToWindow(win.id, null);
  }

  await animateBounds(win, target, STICKY_ANIM_MS);

  scheduleSaveStickies();
  return { deferredUrl };
});

// Renderer pushes comment edits live (debounced) so the persisted snapshot
// stays in sync without main having to poll. No-op when called on a window
// that isn't currently a sticky.
ipcMain.on('wm-sticky-update-comment', (e, comment) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !win._sticky) return;
  win._sticky.comment = typeof comment === 'string' ? comment : '';
  scheduleSaveStickies();
});

// First-render bootstrap: the renderer queries this on init to decide
// whether it's a fresh window (URL hash or blank) or a lazy-restored sticky
// that needs its overlay painted from saved state. Reads _sticky directly so
// non-lazy windows uniformly report `{lazy: false}`.
ipcMain.handle('get-init-state', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win?._sticky?.lazy) return { lazy: false };
  return {
    lazy:    true,
    url:     win._sticky.url,
    verb:    win._sticky.verb,
    label:   win._sticky.label,
    comment: win._sticky.comment || '',
  };
});

ipcMain.on('wm-sticky-new-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  // cascadedBoundsFrom already prefers _sticky.originalBounds, so passing
  // win directly Just Works whether or not the opener is currently shrunken.
  createWindow(null, win);
});

// IPC: settings
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('settings-save', (_e, updated) => {
  const prev = settings;
  settings = { ...settings, ...updated };
  writeSettings();
  if (Object.prototype.hasOwnProperty.call(updated, 'zoom') && updated.zoom !== prev.zoom) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w._guest && !w._guest.isDestroyed()) {
        try { w._guest.setZoomFactor(settings.zoom || 1); } catch {}
      }
      // Re-resize any currently-shrunk sticky to match the new zoom so
      // changing zoom while a sticky is open doesn't leave the window
      // mismatched with its (newly-scaled) content. Update _sticky.stickyBounds
      // so the maximize-intercept handler restores to the post-zoom size.
      // Unlock min/max for the animation, then re-clamp to the new size.
      if (w._sticky && !w.isDestroyed()) {
        const newSticky = stickyBoundsFor(w.getBounds());
        w._sticky.stickyBounds = newSticky;
        unlockStickySize(w);
        animateBounds(w, newSticky, STICKY_ANIM_MS).then(() => {
          if (w.isDestroyed() || !w._sticky) return;
          lockStickySize(w, newSticky.width, newSticky.height);
        });
      }
    }
  }
  // Broadcast the full settings to all renderers — drives live updates
  // for things like the sticky-zoom CSS variable.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings-changed', settings);
  }
});

// IPC: URL/query resolution (renderer search bar shares the same heuristic)
ipcMain.handle('resolve-url', (_e, input) => resolveUrl(input));

// IPC: permission prompt response from the lock UI. `remember` defaults to
// true — single-session "allow once" isn't exposed in the prompt UI; users
// who want to revoke can do so from the lock popover afterwards.
ipcMain.on('permission-response', (_e, { id, allow, remember }) => {
  const req = pendingPermissionRequests.get(id);
  if (!req) return;
  pendingPermissionRequests.delete(id);
  if (remember) {
    for (const k of req.kinds) setGrant(k, req.hostname, allow);
  }
  try { req.callback(!!allow); } catch {}
});

ipcMain.handle('get-permission-grants', (_e, hostname) => {
  if (!hostname) return { camera: undefined, microphone: undefined, geolocation: undefined };
  return getGrantsForHost(hostname);
});

ipcMain.on('set-permission-grant', (_e, { hostname, kind, value }) => {
  if (!hostname || !PERMISSION_KINDS.includes(kind)) return;
  setGrant(kind, hostname, value);
});

// IPC: per-window pastel hue. Renderer reports its hostname on first
// navigation and reads back the assigned hue (or null = no tint).
ipcMain.on('window-navigated', (e, hostname) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) registerWindowHostname(win, hostname);
});
ipcMain.handle('get-window-color', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const info = windowHues.get(win.id);
  return info ? colorForEntry(info) : null;
});

async function savePageAsPdf(win, guest) {
  const send = (payload) => {
    if (!win.isDestroyed()) win.webContents.send('download-event', payload);
  };
  try {
    const title = guest.getTitle() || 'page';
    const safe = title.replace(/[^a-z0-9 _\-]/gi, '').trim().slice(0, 80) || 'page';

    // PDF save is a user-initiated action from the ⋮ menu, not a passive
    // download — always prompt for filename + location, regardless of the
    // askDownloadPath setting which only governs background downloads.
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(effectiveDownloadDir(), `${safe}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      title: 'Save page as PDF',
    });
    if (res.canceled || !res.filePath) return;
    const savePath = res.filePath;
    const filename = path.basename(savePath);

    // Ring appears after the dialog closes so it's feedback for the actual
    // save work (printToPDF + write), which can take a few seconds on long
    // pages. printToPDF doesn't surface progress, so the ring sits at 0%
    // until the write completes.
    const id = ++downloadCounter;
    send({ kind: 'started', id, filename });

    try {
      const pdf = await guest.printToPDF({ printBackground: true });
      await fs.promises.writeFile(savePath, pdf);
      send({ kind: 'done', id, filename, savePath });
    } catch (err) {
      send({ kind: 'failed', id, state: 'failed' });
      dialog.showErrorBox('Save as PDF failed', err.message || String(err));
    }
  } catch (err) {
    dialog.showErrorBox('Save as PDF failed', err.message || String(err));
  }
}

// IPC: toolbar ⋮ menu. The menu itself lives in the renderer as a custom HTML
// popover (so it can be styled square); main just reports state and runs the
// chosen action. `hasPage` gates Refresh / Copy URL / Save page as PDF.
function appMenuStateFor(win) {
  const guest = win?._guest && !win._guest.isDestroyed() ? win._guest : null;
  const url = guest ? guest.getURL() : '';
  return { hasPage: !!url && url !== 'about:blank', url };
}

ipcMain.handle('get-app-menu-state', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { hasPage, url } = appMenuStateFor(win);
  return { hasPage, url };
});

ipcMain.on('app-menu-action', (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const guest = win._guest && !win._guest.isDestroyed() ? win._guest : null;
  const { url } = appMenuStateFor(win);
  switch (action) {
    case 'new-window': createWindow(null, win); break;
    case 'refresh':    guest?.reload(); break;
    case 'copy-url':   if (url) clipboard.writeText(url); break;
    case 'save-pdf':   if (guest) savePageAsPdf(win, guest); break;
    case 'settings':   openSettingsWindow(); break;
  }
});

// IPC: bulk privacy actions (every persisted partition + default session)
ipcMain.handle('delete-cookies', async () => {
  for (const s of await eachSession()) {
    await s.clearStorageData({ storages: ['cookies'] });
  }
});
ipcMain.handle('delete-cache', async () => {
  for (const s of await eachSession()) await s.clearCache();
});

// IPC: downloads
ipcMain.handle('default-download-path', () => app.getPath('downloads'));
ipcMain.handle('pick-download-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win || undefined, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: effectiveDownloadDir(),
    title: 'Choose download folder',
  });
  if (res.canceled || !res.filePaths[0]) return null;
  settings.downloadPath = res.filePaths[0];
  writeSettings();
  return settings.downloadPath;
});
ipcMain.on('show-download-in-folder', (_e, savePath) => {
  if (savePath && fs.existsSync(savePath)) shell.showItemInFolder(savePath);
});

// macOS routes protocol clicks (http/https) through `open-url`, not argv. The
// event can fire before app.whenReady(), so queue and drain on ready.
let pendingOpenUrl = null;
app.on('open-url', (event, openedUrl) => {
  event.preventDefault();
  if (app.isReady()) createWindow(resolveUrl(openedUrl));
  else pendingOpenUrl = openedUrl;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const urlArg = pickUrlArg(argv, 1);
    createWindow(urlArg ? resolveUrl(urlArg) : null);
  });

  // macOS: dock-icon click with no real windows should re-create one. Parked
  // stickies don't count — a sticky can't browse, so clicking the dock when
  // only stickies are open still needs a fresh blank window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 || onlyStickyWindowsOpen()) {
      createWindow(null);
    }
  });

  // Attach download handler to every session — default and per-site partitions.
  // session-created fires when Chromium first instantiates a partition (e.g.
  // via webview partition="persist:foo"), so this catches them lazily.
  app.on('session-created', attachDownloadHandler);

  app.whenReady().then(async () => {
    // Block until Castlabs' Component Updater has the Widevine CDM installed.
    // First launch: triggers download, then resolves. Subsequent launches:
    // resolves immediately. Linux quirk per Castlabs docs — components
    // installed for the first time require an app restart before they
    // function (sandboxing). The user just relaunches.
    try {
      await components.whenReady();
      console.log('[Castlabs] components ready:', components.status());
    } catch (err) {
      // Don't block window creation — surface the failure but let the
      // browser still be usable for non-DRM sites. ComponentsError has an
      // `errors` array with per-component failure details.
      console.error('[Castlabs] components failed to install:', err.message);
      if (err.errors) {
        for (const e of err.errors) console.error('  -', e.id, e.message || e);
      }
    }

    attachDownloadHandler(session.defaultSession);

    // Register as candidate handler for http/https. No-op on Linux (handled
    // by the .desktop MimeType line); on macOS/Windows this lets the OS
    // chooser offer the app for protocol clicks.
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');

    // Rehydrate any sticky-noted windows from the previous session before
    // opening anything else. Each becomes a lazy sticky (no URL loaded, no
    // guest process) until the user maximises it. See the "Sticky-window
    // persistence" section for the full lifecycle.
    const savedStickies = loadStickiesFromDisk();
    for (const entry of savedStickies) {
      if (!entry?.stickyBounds || !entry?.originalBounds) continue;
      createWindow(null, null, { restoreSticky: entry });
    }

    if (pendingOpenUrl) {
      createWindow(resolveUrl(pendingOpenUrl));
      pendingOpenUrl = null;
    } else {
      // argv[1] is main.js in dev, first user arg in packaged AppImage
      const argvStart = app.isPackaged ? 1 : 2;
      const urlArg = pickUrlArg(process.argv, argvStart);
      // Always open a browse-ready window on launch. Restored stickies stay
      // parked alongside it — a sticky can't load a URL until restored, so
      // surfacing only stickies leaves the user with nothing to browse from.
      createWindow(urlArg ? resolveUrl(urlArg) : null);
    }

    // GitHub Releases auto-updater. Skipped in dev (the updater checks
    // app.isPackaged itself). Delayed a few seconds so the first window can
    // finish laying out before a modal native dialog might pop on top of it.
    setTimeout(() => {
      checkForUpdates({ onStartDownload: setPendingDownloadOwner }).catch(() => {});
    }, 3000);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Flush any pending stickies write before exit — the debounce timer would
  // otherwise be cancelled on process shutdown and the last few seconds of
  // sticky drags / comment edits would be lost.
  app.on('before-quit', () => {
    flushSaveStickies();
  });
}

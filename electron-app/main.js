const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, clipboard, components, screen, desktopCapturer, webContents } = require('electron');
const path = require('path');
const fs   = require('fs');

// Widevine is provided by Castlabs Electron-for-Content (the `electron` dep
// is their VMP-signed fork, see DRM_SETUP.md). The CDM is installed by
// Chromium's Component Updater Service the first time `components.whenReady()`
// resolves — see app.whenReady() below.

// `userData` is `appData/<package.json name>` — i.e. `folia-browser` on every
// platform — so this stays consistent regardless of where Chromium parks
// other state (cookies, the Castlabs Components/CDM cache, etc.).
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// downloadPath null → use the platform downloads folder (resolved at use-time
// because app.getPath('downloads') is only valid after `app` is constructed).
const SETTINGS_DEFAULTS = {
  searchEngine: 'ecosia',
  drmEnabled: false,
  downloadPath: null,
  askDownloadPath: false,
  zoom: 1,
  pastelHues: true,
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

// Per-window pastel hue assignment. Each window with a known hostname gets a
// slot in `windowHues`; the renderer paints its toolbar with `hsl(hue, …)`.
// Assignment is sticky — once a window has a hue, it keeps it until close —
// so users can rely on "the blue one" staying blue. A new window prefers the
// hash of its hostname (same site → same colour), but if that's too close to
// any open window's existing hue it slides into the largest gap on the wheel.
// Single-window case clears the hue so a lone window stays default grey.
const windowHues = new Map();  // winId -> { hostname, hue: number | null }
const HUE_SPACING_FACTOR = 0.7;

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

function sendHueToWindow(winId, hue) {
  const w = BrowserWindow.fromId(winId);
  if (w && !w.isDestroyed()) w.webContents.send('hue-changed', hue);
}

function recomputeHues() {
  const enabled = settings.pastelHues !== false;
  const entries = [...windowHues.entries()];
  const shouldTint = enabled && entries.length >= 2;

  if (!shouldTint) {
    for (const [id, info] of entries) {
      if (info.hue !== null) {
        info.hue = null;
        sendHueToWindow(id, null);
      }
    }
    return;
  }

  // Sticky: keep existing assignments, only fill null slots (insertion order).
  const assigned = entries.map(([, info]) => info.hue).filter((h) => h !== null);
  for (const [id, info] of entries) {
    if (info.hue !== null) continue;
    const preferred = hostnameHue(info.hostname);
    const hue = assignHue(preferred, assigned);
    info.hue = hue;
    assigned.push(hue);
    sendHueToWindow(id, hue);
  }
}

function registerWindowHostname(win, hostname) {
  if (!hostname || windowHues.has(win.id)) return;
  windowHues.set(win.id, { hostname, hue: null });
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

function cascadedBoundsFrom(opener) {
  if (!opener || opener.isDestroyed()) return null;
  const o = opener.getBounds();
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
  if (arg.startsWith('http://') || arg.startsWith('https://')) return arg;
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
function createWindow(url, opener) {
  const cascade = cascadedBoundsFrom(opener || BrowserWindow.getFocusedWindow());
  const win = new BrowserWindow({
    width:  cascade ? cascade.width  : 1200,
    height: cascade ? cascade.height : 800,
    ...(cascade ? { x: cascade.x, y: cascade.y } : {}),
    // macOS hosts the close/min/max as native traffic lights inset into the
    // toolbar; other OSes use HTML buttons inside #wm-buttons.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
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

  // Empty hash → renderer shows the search bar and waits for input.
  const hash = url ? '#' + encodeURIComponent(url) : '';
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
    const ownerWin = findOwningWindow(wc);
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

// IPC: window controls
ipcMain.on('wm-close',    (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('wm-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('wm-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

// IPC: settings
ipcMain.handle('get-settings', () => settings);
ipcMain.on('settings-save', (_e, updated) => {
  const prev = settings;
  settings = { ...settings, ...updated };
  writeSettings();
  if (Object.prototype.hasOwnProperty.call(updated, 'zoom') && updated.zoom !== prev.zoom) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w._guest && !w._guest.isDestroyed()) {
        try { w._guest.setZoomFactor(settings.zoom || 1); } catch {}
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(updated, 'pastelHues') && updated.pastelHues !== prev.pastelHues) {
    recomputeHues();
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
ipcMain.handle('get-window-hue', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  return windowHues.get(win.id)?.hue ?? null;
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

  // macOS: dock-icon click with no windows open should re-create one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
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

    if (pendingOpenUrl) {
      createWindow(resolveUrl(pendingOpenUrl));
      pendingOpenUrl = null;
    } else {
      // argv[1] is main.js in dev, first user arg in packaged AppImage
      const argvStart = app.isPackaged ? 1 : 2;
      const urlArg = pickUrlArg(process.argv, argvStart);
      createWindow(urlArg ? resolveUrl(urlArg) : null);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

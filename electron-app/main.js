const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, components } = require('electron');
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
  searchEngine: 'duckduckgo',
  drmEnabled: false,
  downloadPath: null,
  askDownloadPath: false,
};

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

function resolveUrl(arg) {
  if (!arg || arg.startsWith('-')) return 'https://duckduckgo.com';
  if (arg.startsWith('http://') || arg.startsWith('https://')) return arg;
  if (!arg.includes(' ') && arg.includes('.')) return 'https://' + arg;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(arg);
}

function pickUrlArg(argv, start) {
  return argv.slice(start).find(a => !a.startsWith('-'));
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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
      createWindow(newUrl);
      return { action: 'deny' };
    });

    // Gate Widevine / EME on the DRM toggle. Reading settings.drmEnabled
    // through the module-level ref means the new value takes effect on the
    // next permission request (page reload).
    wvContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'media-key-system-access') {
        return callback(settings.drmEnabled === true);
      }
      callback(true);
    });
  });

  // Linux-only: intercept fullscreen → maximize so the rounded-corner border
  // stays visible. macOS users expect Cmd+Ctrl+F native fullscreen; Windows
  // doesn't need this either.
  if (process.platform === 'linux') {
    win.on('enter-full-screen', () => {
      win.setFullScreen(false);
      win.maximize();
    });
  }
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

function broadcastDownload(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('download-event', payload);
  }
}

let downloadCounter = 0;

function attachDownloadHandler(sess) {
  if (sess.__foliaDlAttached) return;
  sess.__foliaDlAttached = true;
  sess.on('will-download', (_event, item) => {
    const id = ++downloadCounter;
    const filename = item.getFilename();

    if (!settings.askDownloadPath) {
      const target = uniqueDownloadPath(effectiveDownloadDir(), filename);
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      item.setSavePath(target);
    }
    // else: leave savePath unset → Electron shows the native save dialog.

    broadcastDownload({ kind: 'started', id, filename });

    item.on('updated', (_e, state) => {
      if (state === 'progressing') {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        const progress = total > 0 ? received / total : 0;
        broadcastDownload({ kind: 'progress', id, progress, paused: item.isPaused() });
      }
    });

    item.on('done', (_e, state) => {
      if (state === 'completed') {
        broadcastDownload({ kind: 'done', id, filename, savePath: item.getSavePath() });
      } else {
        broadcastDownload({ kind: 'failed', id, state });
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
  settings = { ...settings, ...updated };
  writeSettings();
});

// IPC: URL/query resolution (renderer search bar shares the same heuristic)
ipcMain.handle('resolve-url', (_e, input) => resolveUrl(input));

// IPC: app menu — opened by the ⋮ button on the toolbar.
ipcMain.on('show-context-menu', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  Menu.buildFromTemplate([
    { label: 'New window', click: () => createWindow(null) },
    { label: 'Settings',   click: () => openSettingsWindow() },
  ]).popup({ window: win });
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

// GitHub Releases auto-updater. One-shot check on app start: hits the
// /releases/latest endpoint, compares against `app.getVersion()`, and if there
// is something newer, asks the user (native dialog) whether to download. A
// "yes" turns into a `session.downloadURL()` on the persist:folia session, so
// the download flows through the same will-download → toolbar download-ring UI
// that webview-initiated downloads use. We don't install the package — that's
// platform-specific and needs the user's sudo password (rpm/deb) or admin
// privileges (exe/dmg) — we just put the installer in the downloads folder
// and let the user run it manually.
//
// Installer format auto-matches the platform:
//   - darwin     → .dmg
//   - win32      → .exe
//   - linux      → .deb on Debian-family distros (debian, ubuntu, mint, pop,
//                  kali, raspbian), .rpm on everything else (fedora, rhel,
//                  centos, suse, opensuse, rocky, alma, …). Detected via
//                  /etc/os-release ID and ID_LIKE.

const { app, dialog, session, BrowserWindow } = require('electron');
const fs = require('fs');

const RELEASES_URL = 'https://api.github.com/repos/lhdharris/folia-browser/releases/latest';

function compareVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Returns 'deb' | 'rpm' | 'dmg' | 'exe' | null. Linux family detection reads
// /etc/os-release ID and ID_LIKE; unknown distros fall through to 'rpm' (the
// project's primary Linux target, and what openSUSE — the dev box — uses).
function detectInstallerFormat() {
  if (process.platform === 'darwin') return 'dmg';
  if (process.platform === 'win32')  return 'exe';
  if (process.platform !== 'linux')  return null;

  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const id     = (/^ID=(.+)$/m.exec(text)?.[1] || '').replace(/["']/g, '').toLowerCase();
    const idLike = (/^ID_LIKE=(.+)$/m.exec(text)?.[1] || '').replace(/["']/g, '').toLowerCase();
    const all = id + ' ' + idLike;
    if (/\b(debian|ubuntu|mint|pop|kali|raspbian)\b/.test(all)) return 'deb';
  } catch {}
  return 'rpm';
}

function pickAsset(assets, format) {
  if (!Array.isArray(assets)) return null;
  const ext = '.' + format;
  return assets.find((a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith(ext)) || null;
}

function formatBytes(b) {
  if (!b || b <= 0) return '';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

async function fetchLatestRelease() {
  // GitHub requires a User-Agent for unauthenticated requests; without one the
  // API returns 403. Node 18+ ships global fetch, which Electron 42 has.
  const res = await fetch(RELEASES_URL, {
    headers: {
      'User-Agent': 'Folia-Browser-Updater',
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

let checkStarted = false;

// `onStartDownload(ownerWin)` — called right before `downloadURL` so main.js
// can stash the owner window for the upcoming will-download event (which has
// no webview webContents to look up via the normal `findOwningWindow(wc)`
// path, so without a hint the download UI would never appear).
async function checkForUpdates({ onStartDownload } = {}) {
  if (checkStarted) return;
  checkStarted = true;

  // Dev runs (`npm start`) get `isPackaged === false` and version straight from
  // package.json — there is no "installed" version to update. Skip.
  if (!app.isPackaged) return;

  let release;
  try {
    release = await fetchLatestRelease();
  } catch {
    return;
  }
  if (!release || typeof release.tag_name !== 'string') return;

  const latest  = release.tag_name.replace(/^v/i, '');
  const current = app.getVersion();
  if (compareVersion(latest, current) <= 0) return;

  const format = detectInstallerFormat();
  if (!format) return;

  const asset = pickAsset(release.assets, format);
  if (!asset || !asset.browser_download_url) return;

  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const sizeText = asset.size ? `  (${formatBytes(asset.size)})` : '';
  const { response } = await dialog.showMessageBox(parent || undefined, {
    type: 'info',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Folia Browser update available',
    message: `Folia Browser ${latest} is available`,
    detail: `You have ${current}. Download ${asset.name}${sizeText}?\n\nThe installer will be saved to your downloads folder — run it from there to update.`,
  });
  if (response !== 0) return;

  const dlSession = session.fromPartition('persist:folia');
  const ownerWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  if (typeof onStartDownload === 'function') onStartDownload(ownerWin);
  dlSession.downloadURL(asset.browser_download_url);
}

module.exports = { checkForUpdates };

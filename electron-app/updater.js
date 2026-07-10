// GitHub Releases auto-updater. Polls the /releases endpoint at startup
// and every CHECK_INTERVAL_MS thereafter, picks the highest-versioned
// release the user is eligible for, compares against `app.getVersion()`,
// and if something is newer, asks the user (native dialog) whether to
// download. A "yes" turns into a `session.downloadURL()` on the
// persist:folia session, routed to `userData/updates/` so installers
// don't pile up in the Downloads folder. On completion the user is
// prompted to install; on accept the OS launches the platform's package
// installer (xdg-open / open / direct .exe spawn), Folia quits, and the
// installer can replace files cleanly.
//
// Channel rules — the user's installed version picks the channel:
//   - Stable users (e.g. 2.0.0): only stable releases. They don't get
//     pulled onto a beta automatically; opting in means manually
//     installing a pre-release.
//   - Pre-release users (e.g. 2.0.0-beta.3): both pre-releases *and*
//     stable. Beta-to-beta updates work (2.0.0-beta.3 → 2.0.0-beta.4),
//     and when the stable 2.0.0 ships, beta testers roll forward to it
//     automatically — SemVer ranks a stable version above any of its
//     pre-releases, so the comparator picks stable as soon as it lands.
// We can't use /releases/latest for this — GitHub explicitly excludes
// pre-releases from that endpoint, so beta-to-beta updates would never
// be offered.
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
const path = require('path');
const { spawn } = require('child_process');

// per_page=30 is well above the project's likely release cadence; if we
// ever publish more than that we'd want to paginate, but a single round
// trip keeps the startup check cheap.
const RELEASES_URL = 'https://api.github.com/repos/lhdharris/folia-browser/releases?per_page=30';

// 4 hours between background re-checks. Long enough not to hammer GitHub's
// 60-req/hour unauthenticated rate limit (which is shared across all of an
// IP's usage), short enough that a beta cut earlier in the day is offered
// without requiring a restart.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// SemVer comparison, including pre-release ordering:
//   - Main version components compared numerically:
//     2.0.0 < 2.0.1 < 2.1.0
//   - A version with no pre-release suffix outranks one with a suffix
//     for the same main version: 2.0.0 > 2.0.0-rc.1 > 2.0.0-beta.5
//   - Within a pre-release suffix, identifiers compare in order;
//     numeric identifiers numerically, alphanumeric lexically, and a
//     numeric identifier ranks below an alphanumeric one at the same
//     position (so 2.0.0-1 < 2.0.0-alpha). A shorter pre-release ranks
//     below a longer one that shares the prefix
//     (2.0.0-beta < 2.0.0-beta.1).
// Returns negative if a < b, positive if a > b, 0 if equal.
function compareVersion(a, b) {
  const splitOnce = (s) => {
    const i = s.indexOf('-');
    return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
  };
  const [aMain, aPre] = splitOnce(a);
  const [bMain, bPre] = splitOnce(b);

  const pa = aMain.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = bMain.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }

  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;

  const ia = aPre.split('.');
  const ib = bPre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const xa = ia[i];
    const xb = ib[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const xaN = /^\d+$/.test(xa) ? parseInt(xa, 10) : null;
    const xbN = /^\d+$/.test(xb) ? parseInt(xb, 10) : null;
    if (xaN !== null && xbN !== null) {
      if (xaN !== xbN) return xaN - xbN;
    } else if (xaN !== null) {
      return -1;
    } else if (xbN !== null) {
      return 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

function isPrerelease(version) {
  return version.includes('-');
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
  const candidates = assets.filter(
    (a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith(ext)
  );
  if (candidates.length <= 1) return candidates[0] || null;

  // More than one asset carries this extension. macOS ships a separate dmg
  // per CPU arch (Castlabs' per-arch Widevine signatures block a universal
  // binary, so we can't merge them) — "Folia Browser-<ver>.dmg" is the x64
  // build, "…-arm64.dmg" the Apple Silicon one. Match the running arch so an
  // Apple Silicon Mac isn't handed the Intel dmg or vice-versa. electron-builder
  // only tags the non-default arch in the filename (arm64 gets an "arm64"
  // token; the x64 build gets none), so "name contains arm64" is the
  // discriminator, with a fallback to the other arch if only one was published.
  // Linux (deb/rpm, x64-only) and Windows (a single multi-arch NSIS exe) have
  // one candidate and never reach here.
  const wantArm = process.arch === 'arm64';
  const armAsset    = candidates.find((a) => /arm64/i.test(a.name));
  const nonArmAsset = candidates.find((a) => !/arm64/i.test(a.name));
  return (wantArm ? armAsset || nonArmAsset : nonArmAsset || armAsset) || candidates[0];
}

function formatBytes(b) {
  if (!b || b <= 0) return '';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

async function fetchReleases() {
  // GitHub requires a User-Agent for unauthenticated requests; without one the
  // API returns 403. Node 18+ ships global fetch, which Electron 42 has.
  const res = await fetch(RELEASES_URL, {
    headers: {
      'User-Agent': 'Folia-Browser-Updater',
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data : null;
}

// GitHub returns /releases in created_at order, which is not version order
// (a maintainer can publish an older hotfix after a newer release), so we
// always reduce by compareVersion rather than trusting [0]. Drafts shouldn't
// appear in unauthenticated responses but we skip them defensively.
function pickBestRelease(releases, currentVersion) {
  const userOnPrerelease = isPrerelease(currentVersion);
  let best = null;
  let bestV = null;
  for (const r of releases) {
    if (!r || r.draft) continue;
    if (typeof r.tag_name !== 'string') continue;
    if (!userOnPrerelease && r.prerelease) continue;
    const v = r.tag_name.replace(/^v/i, '');
    if (!best || compareVersion(v, bestV) > 0) {
      best = r;
      bestV = v;
    }
  }
  return best ? { release: best, version: bestV } : null;
}

// Managed update storage — installers land here, get auto-launched after
// download, and the whole directory is purged at app start so old
// installers don't accumulate. Lives under userData (per-user) rather than
// the system Downloads folder, which is what the user actually sees.
function updatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function cleanupOldInstallers() {
  let dir;
  try { dir = updatesDir(); } catch { return; }
  try {
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  } catch {}
}

// `checking` guards against re-entry from the periodic timer firing while
// a previous check (or its download) is still in flight. `dismissedVersion`
// remembers the version the user said "Later" to so the periodic re-check
// doesn't keep nagging them about the same release; it resets on every app
// launch, so the prompt comes back next time. A newer release supersedes:
// once `latest` differs from the dismissed value, the prompt fires again.
let checking = false;
let dismissedVersion = null;

async function checkForUpdates({ onStartDownload } = {}) {
  if (checking) return;
  checking = true;
  try {
    await runCheck({ onStartDownload });
  } catch {
    // Network failure, GitHub rate limit, malformed JSON — fail silently
    // and the next interval tick will try again. We never want a failed
    // update check to surface to the user or block other startup work.
  } finally {
    checking = false;
  }
}

async function runCheck({ onStartDownload }) {
  // Dev runs (`npm start`) get `isPackaged === false` and version straight from
  // package.json — there is no "installed" version to update. Skip.
  if (!app.isPackaged) return;

  const releases = await fetchReleases();
  if (!releases || releases.length === 0) return;

  const current = app.getVersion();
  const picked = pickBestRelease(releases, current);
  if (!picked) return;

  const { release, version: latest } = picked;
  if (compareVersion(latest, current) <= 0) return;
  if (latest === dismissedVersion) return;

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
    detail: `You have ${current}. Download ${asset.name}${sizeText}?\n\nThe installer will download in the background and Folia will offer to run it for you when it's ready.`,
  });
  if (response !== 0) {
    dismissedVersion = latest;
    return;
  }

  const dir = updatesDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const savePath = path.join(dir, asset.name);

  const dlSession = session.fromPartition('persist:folia');
  const ownerWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  if (typeof onStartDownload === 'function') {
    onStartDownload(ownerWin, {
      savePath,
      onComplete: (finalPath) => { promptAndInstall(finalPath || savePath); },
    });
  }
  dlSession.downloadURL(asset.browser_download_url);
}

async function promptAndInstall(savePath) {
  if (!savePath || !fs.existsSync(savePath)) return;
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const { response } = await dialog.showMessageBox(parent || undefined, {
    type: 'info',
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Folia Browser update ready',
    message: 'The update has finished downloading.',
    detail: 'Folia will close and the installer will open. Your system will ask you to confirm the install (with your password on Linux, or a UAC prompt on Windows).',
  });
  if (response !== 0) return;
  runInstaller(savePath);
}

// Hand the downloaded installer to the OS's package handler:
//   - linux:  xdg-open → desktop's installer GUI (GNOME Software / Discover /
//             GDebi), which prompts via polkit for the install password
//   - darwin: open → Finder mounts the .dmg; user drags the .app to
//             /Applications. Replacing the running .app would fail on its
//             own, so we quit first.
//   - win32:  spawn the .exe directly → NSIS installer with its own UAC
//             prompt. NSIS can replace files while the app is running with
//             retry, but quitting first avoids needing the retry path.
// In every case the child is detached and unref'd so it survives app.quit().
function runInstaller(savePath) {
  let cmd, args;
  if (process.platform === 'linux') {
    cmd = 'xdg-open'; args = [savePath];
  } else if (process.platform === 'darwin') {
    cmd = 'open'; args = [savePath];
  } else if (process.platform === 'win32') {
    cmd = savePath; args = [];
  } else {
    return;
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    dialog.showErrorBox('Could not launch installer', String(err && err.message || err));
    return;
  }
  app.quit();
}

// One-shot bootstrap for main.js: sweeps stale installers, fires the
// initial check after startup settles, then re-polls on an interval so
// pre-releases published mid-session get picked up without restart.
function startUpdateChecks(opts) {
  cleanupOldInstallers();
  checkForUpdates(opts).catch(() => {});
  setInterval(() => { checkForUpdates(opts).catch(() => {}); }, CHECK_INTERVAL_MS);
}

module.exports = { startUpdateChecks, checkForUpdates };

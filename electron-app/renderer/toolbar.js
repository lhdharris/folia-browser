const webview     = document.getElementById('content');
const back        = document.getElementById('back');
const fwd         = document.getElementById('fwd');
const progressBar = document.getElementById('progress-bar');
const urlBar      = document.getElementById('url-bar');
const lockButton  = document.getElementById('lock-button');
const popover     = document.getElementById('permission-popover');

// Webview preload — wraps getUserMedia / geolocation in the guest page so we
// can show the lock as "in use" while a stream or watch is live. Must be set
// before any `src` assignment or the preload doesn't apply to the first page.
webview.setAttribute('preload', new URL('../webview-preload.js', location.href).href);

// Tag <body> with the platform so CSS can branch (e.g. hide HTML window
// controls on macOS, where native traffic lights live in the titlebar).
document.body.classList.add('platform-' + (window.wm?.platform || 'unknown'));

const initialUrl = decodeURIComponent(location.hash.slice(1));
const isBlank    = !initialUrl;

// Pastel hue: main process assigns this window a hue (or null) based on how
// many other windows are open and what hues they already have. A single
// window stays default grey; 2+ get distinct pastels spaced around the wheel
// so "the blue one" is identifiable at a glance. Sticky — once assigned, a
// window keeps its hue for its lifetime.
function applyToolbarHue(hue) {
  if (typeof hue === 'number') {
    document.documentElement.style.setProperty('--toolbar-bg', `hsl(${hue}, 50%, 90%)`);
  } else {
    document.documentElement.style.removeProperty('--toolbar-bg');
  }
}

window.wm.getWindowHue().then(applyToolbarHue);
window.wm.onHueChanged(applyToolbarHue);

// HTML5 fullscreen: hide the toolbar so the guest can fill the whole window
// (which main has just driven into real OS fullscreen). Restoring is just
// removing the class — the toolbar comes back the moment the page exits.
window.wm.onHtmlFullscreen((isFs) => {
  document.body.classList.toggle('html-fullscreen', isFs);
});

function init() {
  if (isBlank) {
    // Blank window: show the URL bar and wait for the user to submit.
    // The webview gets its partition + src only after the user navigates,
    // and the URL bar is removed from the DOM after that — it cannot come back.
    urlBar.hidden = false;
    if (document.readyState === 'complete') urlBar.focus();
    else window.addEventListener('load', () => urlBar.focus());
    return;
  }
  startLoad(initialUrl);
}

// CRITICAL: defer setting `src` until the window has fully laid out.
// Electron's <webview> creates its guest process when src is set, and the
// guest's initial viewport is locked to whatever dimensions the webview
// element has at that moment. If we set src too early (before the
// frameless window has finished its async layout pass), the guest renders
// forever at a tiny initial viewport.
//
// Partition is fixed (`persist:folia`, set as an HTML attribute in
// index.html) so every window shares one cookie jar — sign in once to
// Google/whatever and every other window picks up the session, including
// cross-site OAuth (claude.ai → accounts.google.com → back). The hostname
// extracted here is just for the per-window hue.
function startLoad(url) {
  let hostname = 'default';
  try { hostname = new URL(url).hostname; } catch {}
  window.wm.notifyNavigated(hostname);

  const fire = () => webview.setAttribute('src', url);
  if (document.readyState === 'complete') {
    setTimeout(fire, 50);
  } else {
    window.addEventListener('load', () => setTimeout(fire, 50));
  }
}

// Build the static action label that replaces the URL bar after the user
// commits. URLs render as the bare hostname (e.g. "github.com"); searches
// render as the quoted query (e.g. "'why is my child crying?'"). Mirrors
// main.js's resolveUrl() heuristic so the label matches what got loaded.
function actionLabelText(input) {
  const trimmed = input.trim();
  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) ||
    (!trimmed.includes(' ') && trimmed.includes('.'));
  if (looksLikeUrl) {
    let host = trimmed;
    try {
      const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
      host = new URL(withScheme).hostname.replace(/^www\./i, '');
    } catch {}
    return host.toLowerCase();
  }
  return `'${trimmed.toLowerCase()}'`;
}

urlBar.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = urlBar.value.trim();
  if (!input) return;
  const resolved = await window.wm.resolveUrl(input);

  // Fade the URL bar out, swap in a static action label, fade that in.
  // The swap runs once (transitionend wins normally; setTimeout is a fallback).
  // Like the URL bar, the label is set once and never updates — subsequent
  // in-page navigation doesn't change it.
  const labelText = actionLabelText(input);
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    const parent = urlBar.parentElement;
    if (urlBar.isConnected) urlBar.remove();
    const label = document.createElement('span');
    label.id = 'action-label';
    label.textContent = labelText;
    label.classList.add('entering');
    parent.appendChild(label);
    void label.offsetWidth;  // force reflow so the fade-in transitions
    label.classList.remove('entering');
  };
  urlBar.classList.add('leaving');
  urlBar.addEventListener('transitionend', swap, { once: true });
  setTimeout(swap, 400);

  startLoad(resolved);
});

init();

// On dom-ready (guest has been created), force the guest page to
// recompute its viewport in case the webview element resized after attach.
webview.addEventListener('dom-ready', () => {
  webview.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
});

// Navigation
back.addEventListener('click', () => webview.goBack());
fwd.addEventListener('click',  () => webview.goForward());

function updateNav() {
  back.disabled = !webview.canGoBack();
  fwd.disabled  = !webview.canGoForward();
}
webview.addEventListener('did-navigate',         updateNav);
webview.addEventListener('did-navigate-in-page', updateNav);

// Loading progress bar
let progressDone = null;

function progressStart() {
  clearTimeout(progressDone);
  // Reset instantly, then animate to 80% over ~8s (slows to a crawl near the end)
  progressBar.style.transition = 'none';
  progressBar.style.opacity    = '1';
  progressBar.style.width      = '0%';
  progressBar.offsetWidth; // force reflow so the reset takes effect
  progressBar.style.transition = 'width 8s cubic-bezier(0.1, 0.05, 0, 1)';
  progressBar.style.width      = '80%';
}

function progressFinish() {
  clearTimeout(progressDone);
  progressBar.style.transition = 'width 0.15s ease-out';
  progressBar.style.width      = '100%';
  progressDone = setTimeout(() => {
    progressBar.style.transition = 'opacity 0.3s ease';
    progressBar.style.opacity    = '0';
    progressDone = setTimeout(() => {
      progressBar.style.transition = 'none';
      progressBar.style.width      = '0%';
      progressBar.style.opacity    = '1';
    }, 300);
  }, 150);
}

webview.addEventListener('did-start-loading', progressStart);
webview.addEventListener('did-stop-loading',  progressFinish);
webview.addEventListener('did-fail-load',     progressFinish);

// Window controls
document.getElementById('close').addEventListener('click',    () => window.wm.close());
document.getElementById('minimize').addEventListener('click', () => window.wm.minimize());
document.getElementById('maximize').addEventListener('click', () => window.wm.toggleMaximize());
// Toolbar ⋮ menu — custom HTML popover. Built once in index.html; this just
// handles open/close, item enable/disable, and dispatch to main. The
// backdrop covers the whole window (including the webview) so any click
// outside the menu reliably dismisses it.
const menuBtn = document.getElementById('menu');
const appMenu = document.getElementById('app-menu');
const appMenuBackdrop = document.getElementById('app-menu-backdrop');

// Render keyboard-accelerator hints based on platform (⌘R on macOS, Ctrl+R
// elsewhere). The keys themselves still come from Chromium's defaults; the
// text is just a discoverability cue, same as the old native menu showed.
{
  const isMac = window.wm?.platform === 'darwin';
  for (const el of appMenu.querySelectorAll('.accel[data-key]')) {
    el.textContent = isMac ? `⌘${el.dataset.key}` : `Ctrl+${el.dataset.key}`;
  }
}

function positionAppMenu() {
  const rect = menuBtn.getBoundingClientRect();
  appMenu.style.left = Math.round(rect.left) + 'px';
  appMenu.style.top  = Math.round(rect.top) + 'px';
}

function closeAppMenu() {
  appMenu.hidden = true;
  appMenuBackdrop.hidden = true;
}

async function openAppMenu() {
  const state = await window.wm.getAppMenuState();
  for (const item of appMenu.querySelectorAll('.item')) {
    item.disabled = item.hasAttribute('data-needs-page') && !state.hasPage;
  }
  appMenuBackdrop.hidden = false;
  appMenu.hidden = false;
  positionAppMenu();
}

// Backdrop click closes the menu. Clicks inside the webview otherwise never
// bubble out to the toolbar's document; the backdrop catches them first.
appMenuBackdrop.addEventListener('mousedown', closeAppMenu);

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (appMenu.hidden) openAppMenu();
  else closeAppMenu();
});

appMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item || item.disabled) return;
  closeAppMenu();
  window.wm.appMenuAction(item.dataset.action);
});

document.addEventListener('mousedown', (e) => {
  if (appMenu.hidden) return;
  if (appMenu.contains(e.target) || menuBtn.contains(e.target)) return;
  closeAppMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !appMenu.hidden) closeAppMenu();
});
webview.addEventListener('focus', () => { if (!appMenu.hidden) closeAppMenu(); });
window.addEventListener('resize', () => { if (!appMenu.hidden) positionAppMenu(); });

// Download ring: shows progress for the most recently started download.
// Click while in-progress → shake-red feedback ("wait"). Click after
// completion → opens the file in its folder and hides the ring.
const ringEl   = document.getElementById('download-ring');
const ringFill = ringEl.querySelector('.fill');
const RING_CIRC = 2 * Math.PI * 9;

const ringState = {
  id: null,
  progress: 0,
  complete: false,
  savePath: null,
};

function setRingProgress(progress) {
  ringFill.style.strokeDashoffset = String(RING_CIRC * (1 - progress));
}

function showRing() {
  ringState.complete = false;
  ringState.progress = 0;
  ringEl.classList.remove('complete');
  ringEl.hidden = false;
  setRingProgress(0);
}

function completeRing(titleAfter) {
  ringState.complete = true;
  ringEl.classList.add('complete');
  ringEl.title = titleAfter;
  setRingProgress(1);
}

function hideRing() {
  ringEl.hidden = true;
  ringEl.classList.remove('complete');
  ringState.id = null;
  ringState.complete = false;
  ringState.savePath = null;
}

window.wm.onDownload((evt) => {
  if (evt.kind === 'started') {
    showRing();
    ringState.id = evt.id;
    ringState.savePath = null;
    ringEl.title = `Downloading ${evt.filename}…`;
    return;
  }
  if (evt.id !== ringState.id) return;
  if (evt.kind === 'progress') {
    ringState.progress = evt.progress;
    setRingProgress(evt.progress);
    return;
  }
  if (evt.kind === 'done') {
    ringState.savePath = evt.savePath;
    completeRing(`Saved ${evt.filename} — click to open folder`);
    return;
  }
  if (evt.kind === 'failed') {
    hideRing();
  }
});

ringEl.addEventListener('click', () => {
  if (!ringState.complete) {
    ringEl.classList.remove('shake-red');
    void ringEl.offsetWidth;  // restart animation if already running
    ringEl.classList.add('shake-red');
    setTimeout(() => ringEl.classList.remove('shake-red'), 400);
    return;
  }
  if (ringState.savePath) {
    window.wm.showDownloadInFolder(ringState.savePath);
  }
  hideRing();
});

// ---- Permissions UI ----------------------------------------------------
// The lock button shows next to the menu button after a permission has been
// requested or granted for the current site, and "unlocks" (warm tint + open
// SVG) while a tracked permission is actively in use. The popover under the
// lock has two modes: a one-shot prompt (Allow/Block) for first-time
// requests, and a manage panel (Allow/Block/Ask per kind) opened by clicking
// the lock outside of a prompt.

const KIND_LABEL = { camera: 'Camera', microphone: 'Microphone', geolocation: 'Location' };

let currentHostname = null;
const activePermissions = new Set();   // 'camera' | 'microphone' | 'geolocation'
let pendingPrompt = null;              // { id, kinds: [...], hostname }
let lockShownForHostname = null;       // hostname the lock is currently visible for

function updateLockIcon() {
  const inUse = activePermissions.size > 0;
  lockButton.classList.toggle('active', inUse);
  if (inUse) {
    const names = [...activePermissions].map((k) => KIND_LABEL[k]).join(', ');
    lockButton.title = `In use: ${names}`;
  } else {
    lockButton.title = 'Site permissions';
  }
}

function showLockForHostname(hostname) {
  if (!hostname) return;
  lockButton.hidden = false;
  lockShownForHostname = hostname;
}

async function refreshLockVisibility() {
  if (!currentHostname) return;
  if (lockShownForHostname === currentHostname) return;
  const grants = await window.wm.getPermissionGrants(currentHostname);
  if (Object.values(grants).some((v) => v !== undefined)) {
    showLockForHostname(currentHostname);
  }
}

function positionPopover() {
  const rect = lockButton.getBoundingClientRect();
  popover.style.left = Math.round(rect.left) + 'px';
  popover.style.top  = Math.round(rect.bottom + 4) + 'px';
}

function hidePopover() {
  popover.hidden = true;
  popover.replaceChildren();
}

function showPromptPopover() {
  if (!pendingPrompt) return;
  const { kinds, hostname } = pendingPrompt;
  popover.replaceChildren();

  const text = document.createElement('div');
  text.className = 'prompt-text';
  const kindNames = kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' and ');
  const host = document.createElement('strong');
  host.textContent = hostname;
  text.append(host, document.createTextNode(` wants to use your ${kindNames}.`));
  popover.appendChild(text);

  const buttons = document.createElement('div');
  buttons.className = 'prompt-buttons';
  const block = document.createElement('button');
  block.className = 'block';
  block.textContent = 'Block';
  block.addEventListener('click', () => respondPrompt(false));
  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = 'Allow';
  allow.addEventListener('click', () => respondPrompt(true));
  buttons.append(block, allow);
  popover.appendChild(buttons);

  popover.hidden = false;
  positionPopover();
}

function respondPrompt(allow) {
  const p = pendingPrompt;
  if (!p) return;
  pendingPrompt = null;
  hidePopover();
  window.wm.respondPermissionRequest(p.id, allow, true);
  refreshLockVisibility();
}

async function showManagePopover() {
  if (!currentHostname) return;
  popover.replaceChildren();

  const header = document.createElement('h3');
  header.textContent = currentHostname;
  popover.appendChild(header);

  const grants = await window.wm.getPermissionGrants(currentHostname);
  for (const kind of ['camera', 'microphone', 'geolocation']) {
    const row = document.createElement('div');
    row.className = 'row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'row-label';
    const labelTop = document.createElement('span');
    labelTop.textContent = KIND_LABEL[kind];
    labelWrap.appendChild(labelTop);
    if (activePermissions.has(kind)) {
      const inUse = document.createElement('span');
      inUse.className = 'in-use';
      inUse.textContent = 'in use now';
      labelWrap.appendChild(inUse);
    }
    row.appendChild(labelWrap);

    const seg = document.createElement('div');
    seg.className = 'seg';
    const current = grants[kind];
    const opts = [
      { val: true,      cls: 'allow', text: 'Allow' },
      { val: false,     cls: 'block', text: 'Block' },
      { val: undefined, cls: 'ask',   text: 'Ask' },
    ];
    for (const opt of opts) {
      const btn = document.createElement('button');
      btn.className = opt.cls + (current === opt.val ? ' current' : '');
      btn.textContent = opt.text;
      btn.addEventListener('click', () => {
        window.wm.setPermissionGrant(currentHostname, kind, opt.val === undefined ? null : opt.val);
        showManagePopover();  // re-render with new state
      });
      seg.appendChild(btn);
    }
    row.appendChild(seg);
    popover.appendChild(row);
  }

  popover.hidden = false;
  positionPopover();
}

lockButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!popover.hidden) {
    hidePopover();
    return;
  }
  if (pendingPrompt) showPromptPopover();
  else showManagePopover();
});

// Click anywhere else (including inside the webview) → close popover.
document.addEventListener('mousedown', (e) => {
  if (popover.hidden) return;
  if (popover.contains(e.target) || lockButton.contains(e.target)) return;
  hidePopover();
});
webview.addEventListener('focus', () => { if (!popover.hidden) hidePopover(); });

// In-use state from the webview preload (postMessage → sendToHost bridge).
webview.addEventListener('ipc-message', (e) => {
  if (e.channel !== 'folia-permission-active') return;
  const data = e.args && e.args[0];
  if (!data || !KIND_LABEL[data.kind]) return;
  if (data.active) activePermissions.add(data.kind);
  else activePermissions.delete(data.kind);
  showLockForHostname(currentHostname);
  updateLockIcon();
  if (!popover.hidden) {
    // Manage popover shows "in use now" labels — re-render so they update.
    if (!pendingPrompt) showManagePopover();
  }
});

// Permission prompt from main.
window.wm.onPermissionRequest((payload) => {
  pendingPrompt = payload;
  showLockForHostname(payload.hostname);
  showPromptPopover();
});

// Track hostname across navigation. did-navigate fires for a fresh page load
// (preload re-runs, so active state is invalid → clear). did-navigate-in-page
// is SPA history changes; preload state is preserved, only hostname/grants
// might change.
function setHostnameFromUrl(url) {
  try { currentHostname = new URL(url).hostname; }
  catch { currentHostname = null; }
}

webview.addEventListener('did-navigate', (e) => {
  setHostnameFromUrl(e.url);
  activePermissions.clear();
  lockShownForHostname = null;
  lockButton.hidden = true;
  updateLockIcon();
  hidePopover();
  refreshLockVisibility();
});
webview.addEventListener('did-navigate-in-page', (e) => {
  if (!e.isMainFrame) return;
  const prev = currentHostname;
  setHostnameFromUrl(e.url);
  if (currentHostname !== prev) {
    lockShownForHostname = null;
    lockButton.hidden = true;
    refreshLockVisibility();
  }
});

window.addEventListener('resize', () => { if (!popover.hidden) positionPopover(); });

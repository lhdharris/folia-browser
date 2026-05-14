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

// Per-window colour: main computes a CSS colour string and pushes it via
// onWindowColor. Pastel hsl when assigned a hue (multi-window distinction);
// a literal #FFFFE0 when the window has been sticky-noted while alone (the
// colour locks for the window's lifetime). null = default grey.
function applyToolbarColor(color) {
  if (typeof color === 'string') {
    document.documentElement.style.setProperty('--toolbar-bg', color);
  } else {
    document.documentElement.style.removeProperty('--toolbar-bg');
  }
}

window.wm.getWindowColor().then(applyToolbarColor);
window.wm.onWindowColor(applyToolbarColor);

// HTML5 fullscreen: hide the toolbar so the guest can fill the whole window
// (which main has just driven into real OS fullscreen). Restoring is just
// removing the class — the toolbar comes back the moment the page exits.
window.wm.onHtmlFullscreen((isFs) => {
  document.body.classList.toggle('html-fullscreen', isFs);
});

// Action label state — what the toolbar's static label says and how it
// got there. Exposed module-level so the sticky-note minimize can render
// "Visited ctvnews.ca" / "Searched for 'foo'". Set once per window
// lifetime (search-vs-visit can't change after URL-bar submission, and
// URL-opened windows are always visits).
let actionVerb  = null;  // 'Visited' | 'Searched for' | null
let actionLabel = null;  // hostname / "'query'" — same string used by #action-label
// URL the webview is currently sitting on. Captured at startLoad time and
// updated on did-navigate(-in-page); read at sticky-shrink time so main can
// persist what URL to reload on lazy-restore.
let currentLoadedUrl = null;

async function init() {
  // Sticky-note persistence: if main reports this is a lazy-restored
  // sticky, paint the overlay from saved state and skip loading any URL.
  // The webview stays src-less until the user maximises and the deferred
  // URL kicks in via restoreFromSticky's return value.
  const initState = await window.wm.getInitState();
  if (initState?.lazy) {
    actionVerb  = initState.verb || null;
    actionLabel = initState.label || null;
    currentLoadedUrl = initState.url || null;
    if (actionLabel) placeStaticLabel(actionLabel);
    enableStickyButton();
    stickyTitle.textContent = composeStickyTitle();
    stickyComment.textContent = initState.comment || '';
    stickyOverlay.hidden = false;
    document.body.classList.add('sticky-mode');
    return;
  }

  if (isBlank) {
    // Blank window: show the URL bar and wait for the user to submit.
    // The webview gets its partition + src only after the user navigates,
    // and the URL bar is removed from the DOM after that — it cannot come back.
    urlBar.hidden = false;
    if (document.readyState === 'complete') urlBar.focus();
    else window.addEventListener('load', () => urlBar.focus());
    return;
  }
  // Window opened with a URL (target=_blank, OS file association, second-
  // instance with argv, etc.): drop a static label into the toolbar so the
  // window is identifiable at a glance. Same slot the post-submit label
  // uses, just placed up-front instead of swapped in after URL-bar Enter.
  actionVerb = 'Visited';
  actionLabel = labelTextForUrl(initialUrl);
  placeStaticLabel(actionLabel);
  enableStickyButton();
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
// extracted here is just for the per-window hue — file:// URLs report no
// hostname, so they share the `local-file` slot (still non-empty, so the
// window gets registered and tinted alongside http windows).
function startLoad(url) {
  currentLoadedUrl = url;
  let hostname = 'default';
  try {
    const u = new URL(url);
    hostname = u.hostname || (u.protocol === 'file:' ? 'local-file' : 'default');
  } catch {}
  window.wm.notifyNavigated(hostname);

  const fire = () => webview.setAttribute('src', url);
  if (document.readyState === 'complete') {
    setTimeout(fire, 50);
  } else {
    window.addEventListener('load', () => setTimeout(fire, 50));
  }
}

// Keep currentLoadedUrl tracking the guest's actual URL across in-page
// navigations (SPA history pushState, link clicks). Used by sticky shrink
// to persist what to reload on next-launch lazy-restore.
webview.addEventListener('did-navigate', (e) => {
  if (e.url) currentLoadedUrl = e.url;
});
webview.addEventListener('did-navigate-in-page', (e) => {
  if (e.isMainFrame && e.url) currentLoadedUrl = e.url;
});

// Static label for windows that opened with a URL (no URL bar to type into).
// `file://` → file basename; `http(s)://` → bare hostname. Mirrors the
// post-submit label produced by actionLabelInfo().
function labelTextForUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      const p = decodeURIComponent(u.pathname);
      return p.split('/').filter(Boolean).pop() || p;
    }
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url;
  }
}

function placeStaticLabel(text) {
  const parent = urlBar.parentElement;
  if (urlBar.isConnected) urlBar.remove();
  const label = document.createElement('span');
  label.id = 'action-label';
  label.textContent = text;
  parent.appendChild(label);
}

// Folia is tabless: once a window has navigated, the address slot is a
// static #action-label, not an editable URL bar. Clicking it does nothing
// useful — so the click is treated as a "can I type here?" gesture and the
// label shakes "no". After three clicks the ⋮ menu pulses green; opening
// the menu while in that state also pulses the "New window" item, pointing
// the user at how to actually navigate. Counter resets when the user
// follows the hint (clicks New window from the menu).
let urlBarShakeCount = 0;

function shakeActionLabel(label) {
  label.classList.remove('shake-no');
  void label.offsetWidth;  // restart animation if mid-shake
  label.classList.add('shake-no');
  setTimeout(() => label.classList.remove('shake-no'), 500);
}

function flashMenuButtonGreen() {
  const btn = document.getElementById('menu');
  btn.classList.remove('flash-green');
  void btn.offsetWidth;
  btn.classList.add('flash-green');
  setTimeout(() => btn.classList.remove('flash-green'), 1250);
}

function flashNewWindowItemGreen() {
  const item = document.querySelector('#app-menu .item[data-action="new-window"]');
  if (!item) return;
  item.classList.remove('flash-green');
  void item.offsetWidth;
  item.classList.add('flash-green');
  setTimeout(() => item.classList.remove('flash-green'), 1350);
}

// Event delegation: #action-label is added to #drag-space dynamically
// (either by placeStaticLabel for URL-opened windows or by the urlBar
// Enter handler for blank windows). Listening on the parent catches both
// paths without re-binding.
document.getElementById('drag-space').addEventListener('click', (e) => {
  if (!e.target.closest('#action-label')) return;
  urlBarShakeCount++;
  shakeActionLabel(e.target.closest('#action-label'));
  if (urlBarShakeCount >= 3) {
    // Sequence the flash after the shake so the user reads it as
    // "no … → look here". 300ms is roughly mid-shake; the green pulse
    // peaks just as the shake finishes.
    setTimeout(flashMenuButtonGreen, 300);
  }
});

// Build the static action label that replaces the URL bar after the user
// commits. URLs render as the bare hostname (e.g. "github.com"); searches
// render as the quoted query (e.g. "'why is my child crying?'"). Mirrors
// main.js's resolveUrl() heuristic so the label matches what got loaded.
// Returns {verb, text}: verb is the sticky-note prefix ("Visited" /
// "Searched for"), text is what goes into #action-label.
function actionLabelInfo(input) {
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
    return { verb: 'Visited', text: host.toLowerCase() };
  }
  return { verb: 'Searched for', text: `'${trimmed.toLowerCase()}'` };
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
  const { verb, text } = actionLabelInfo(input);
  actionVerb = verb;
  actionLabel = text;
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    const parent = urlBar.parentElement;
    if (urlBar.isConnected) urlBar.remove();
    const label = document.createElement('span');
    label.id = 'action-label';
    label.textContent = text;
    label.classList.add('entering');
    parent.appendChild(label);
    void label.offsetWidth;  // force reflow so the fade-in transitions
    label.classList.remove('entering');
    enableStickyButton();
  };
  urlBar.classList.add('leaving');
  urlBar.addEventListener('transitionend', swap, { once: true });
  setTimeout(swap, 400);

  startLoad(resolved);
});

// On dom-ready (guest has been created), force the guest page to
// recompute its viewport in case the webview element resized after attach.
webview.addEventListener('dom-ready', () => {
  webview.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
});

// Mirror the guest page's <title> into document.title so the OS-level window
// title (Alt-Tab, GNOME activities, taskbar) shows what's actually loaded
// instead of every Folia window saying "Folia Browser". Electron's BrowserWindow
// auto-syncs from document.title via its own page-title-updated event. Skip
// empties — keep the static "Folia Browser" fallback from index.html.
webview.addEventListener('page-title-updated', (e) => {
  const t = (e.title || '').trim();
  if (t) document.title = `${t} — Folia Browser`;
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

// Window controls. The "minimize" slot has been replaced with the sticky-
// note shrink (handled below); only close + maximize stay as plain wm calls.
document.getElementById('close').addEventListener('click',    () => window.wm.close());
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
  // If the URL-bar-click hint sequence is active (≥3 shakes on
  // #action-label), pulse the "New window" item to complete the visual
  // breadcrumb. Stays on every menu open until the user actually picks
  // new-window and the counter resets.
  if (urlBarShakeCount >= 3) flashNewWindowItemGreen();
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
  // Following the green-breadcrumb resets the URL-bar-click hint on
  // THIS window — next click on #action-label shakes from step 1 again.
  if (item.dataset.action === 'new-window') urlBarShakeCount = 0;
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

// ---- Sticky-note minimize ---------------------------------------------
// Replaces the OS-level minimize. Clicking #sticky shrinks the OS window
// to a small on-desktop "post-it" carrying:
//   - the action label as a bold prefix-verb-style title ("Visited X" /
//     "Searched for 'Y'")
//   - an italic contenteditable comment for the user to remind themselves
//     why they parked it
// Clicking anywhere on the sticky body (excluding the comment area and
// the hover-only ⋮ menu) restores the window. Main owns the bounds
// animation; renderer just toggles `body.sticky-mode`.

const stickyBtn       = document.getElementById('sticky');
const stickyOverlay   = document.getElementById('sticky-overlay');
const stickyTitle     = document.getElementById('sticky-title');
const stickyComment   = document.getElementById('sticky-comment');
const stickyAudioIcon = document.getElementById('sticky-audio-icon');

// Sticky size scales with the global zoom setting (settings.zoom). Setting
// --sticky-zoom on :root drives all internal padding/font/button sizes via
// calc(... * var(--sticky-zoom)) in style.css. Window dimensions (set in
// main when shrinking) scale to match. Re-applied on settings-change so
// changing zoom while a sticky is open updates it live.
function applyStickyZoom(zoom) {
  document.documentElement.style.setProperty('--sticky-zoom', zoom || 1);
}
window.wm.getSettings().then((s) => applyStickyZoom(s?.zoom));
window.wm.onSettingsChanged((s) => applyStickyZoom(s?.zoom));

// Audio indicator: speaker glyph next to the sticky title appears whenever
// the webview reports audible=true (audio-state-changed). State persists
// across shrink/restore so a parked sticky reflects the page's current
// audio state immediately on shrink.
window.wm.onAudioState((audible) => {
  stickyAudioIcon.classList.toggle('audible', !!audible);
});

function enableStickyButton() {
  stickyBtn.disabled = false;
}

function composeStickyTitle() {
  if (!actionVerb || !actionLabel) return 'Untitled window';
  return `${actionVerb} ${actionLabel}`;
}

function placeCursorAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

stickyBtn.addEventListener('click', async () => {
  if (stickyBtn.disabled) return;
  stickyTitle.textContent = composeStickyTitle();
  stickyOverlay.hidden = false;
  document.body.classList.add('sticky-mode');
  // Main animates the OS window down to STICKY_W×STICKY_H; the promise
  // resolves once the bounds animation finishes so we focus the comment
  // *after* the visual settles. Payload is what main persists for next-
  // launch lazy-restore (URL to defer-load, title parts, comment text).
  await window.wm.shrinkToSticky({
    url:     currentLoadedUrl,
    verb:    actionVerb,
    label:   actionLabel,
    comment: stickyComment.textContent || '',
  });
  stickyComment.focus();
  placeCursorAtEnd(stickyComment);
});

async function restoreFromSticky() {
  // Animate first, then drop the class — this way the sticky note grows
  // visually with the window resize, then the chrome snaps back into
  // view. Hiding the overlay before the animation would show a tiny
  // squished toolbar+webview during the grow.
  const result = await window.wm.restoreFromSticky();
  document.body.classList.remove('sticky-mode');
  stickyOverlay.hidden = true;
  // Lazy-restored stickies carry a deferredUrl: the webview was created
  // src-less so we need to startLoad now that the window is full size.
  // Defer-loading from a still-shrunken webview triggers the
  // layout-too-small bug guarded by startLoad's setTimeout(50ms).
  if (result?.deferredUrl) {
    startLoad(result.deferredUrl);
  }
}

// Comment edits during sticky-mode: persist live (debounced) so the saved
// snapshot tracks what the user typed without waiting for shrink/restore.
let commentSaveTimer = null;
stickyComment.addEventListener('input', () => {
  clearTimeout(commentSaveTimer);
  commentSaveTimer = setTimeout(() => {
    window.wm.updateStickyComment(stickyComment.textContent || '');
  }, 300);
});

// Hover-revealed action icons: +, maximize-square, ×. Each is a no-drag
// click target so the rest of the sticky stays draggable.
document.getElementById('sticky-new').addEventListener('click', (e) => {
  e.stopPropagation();
  window.wm.newWindowFromSticky();
});
document.getElementById('sticky-restore').addEventListener('click', (e) => {
  e.stopPropagation();
  restoreFromSticky();
});
document.getElementById('sticky-x').addEventListener('click', (e) => {
  e.stopPropagation();
  window.wm.close();
});

// Drag is the OS's job: `#sticky-overlay` is marked `-webkit-app-region:
// drag` in style.css, so the compositor handles the move via
// xdg_toplevel.move on Wayland (the only way to reposition a window there
// — clients aren't allowed to call setBounds({x,y,…}) on Wayland). The
// comment area and action buttons opt back out with `no-drag` so they
// remain interactive.

// Dblclick on a sticky triggers the WM's maximize gesture, which on
// GNOME Wayland we can't cleanly suppress (all the post-hoc options
// either drift the size or strand the window in the top-left corner —
// see the `maximize` listener in main.js for the full pathology).
// Instead main re-routes the gesture through this signal, so dblclick
// acts as a "restore" gesture — the same as clicking the maximize-square
// action button.
window.wm.onStickyRestoreRequested(() => {
  if (document.body.classList.contains('sticky-mode')) {
    restoreFromSticky();
  }
});

// Escape inside the comment defocuses it so the next click restores
// instead of staying in the comment. Doesn't restore on its own — keep
// that as an explicit click gesture.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('sticky-mode')) return;
  if (document.activeElement === stickyComment) stickyComment.blur();
});

// Bootstrap. Called last so all module-level consts (sticky DOM refs, the
// hue/colour bridge, etc.) are initialised before init() touches them.
init();

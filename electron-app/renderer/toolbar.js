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

// New windows cascade +32px from the opener, so the equivalent button in the
// new window often lands right under the cursor and inherits :hover. Suppress
// :hover until the user actually moves the mouse inside the new window.
document.body.classList.add('no-hover');
document.addEventListener('mousemove', () => {
  document.body.classList.remove('no-hover');
}, { once: true });

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
    // The webview gets its partition + src only after the user navigates.
    // body.blank-mode hides #webview-wrap so the back-button-restored
    // blank state (which leaves a previously-loaded page parked in the
    // webview) looks identical to a freshly opened window.
    document.body.classList.add('blank-mode');
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
  // Leaving blank-mode: reveal the webview so the new page is visible.
  document.body.classList.remove('blank-mode');
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
//
// Back-navigation can land on the about:blank sentinel that restoreUrlBar
// leaves behind (history becomes [about:blank, URL_NEW] after a restore
// + new navigation). When that happens, surface the URL bar instead of
// showing literal about:blank. The actionLabel guard prevents recursion
// from restoreUrlBar's own setAttribute('src','about:blank').
webview.addEventListener('did-navigate', (e) => {
  if (e.url) currentLoadedUrl = e.url;
  if (e.url === 'about:blank' && actionLabel) {
    restoreUrlBar('');
  }
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

// Pick hint colours that pop against the current toolbar background.
// Read --toolbar-bg (set by applyToolbarColor) and emit complementary
// pastel pairs. Returns null when there's no special toolbar tint (the
// default grey case), and the CSS keyframe falls back to its built-in
// green — same colours the breadcrumb used historically.
function computeHintColors() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--toolbar-bg').trim();
  if (!raw) return null;
  if (raw.toLowerCase() === '#ffffe0') {
    // Sticky-yellow lockedColor → cool blue/indigo pastel.
    return { bg: '#bbdefb', fg: '#1565c0' };
  }
  const m = raw.match(/hsl\(\s*(-?\d+(?:\.\d+)?)\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*\)/i);
  if (m) {
    const h2 = ((Math.round(parseFloat(m[1])) % 360) + 540) % 360;  // +180° on the wheel
    return {
      bg: `hsl(${h2}, 60%, 85%)`,
      fg: `hsl(${h2}, 55%, 28%)`,
    };
  }
  return null;
}

function applyHintColors(el) {
  const colors = computeHintColors();
  if (colors) {
    el.style.setProperty('--hint-bg', colors.bg);
    el.style.setProperty('--hint-fg', colors.fg);
  } else {
    el.style.removeProperty('--hint-bg');
    el.style.removeProperty('--hint-fg');
  }
}

function flashMenuButtonGreen() {
  const btn = document.getElementById('menu');
  applyHintColors(btn);
  btn.classList.remove('flash-green');
  void btn.offsetWidth;
  btn.classList.add('flash-green');
  setTimeout(() => btn.classList.remove('flash-green'), 1250);
}

function flashNewWindowItemGreen() {
  const item = document.querySelector('#app-menu .item[data-action="new-window"]');
  if (!item) return;
  applyHintColors(item);
  item.classList.remove('flash-green');
  void item.offsetWidth;
  item.classList.add('flash-green');
  setTimeout(() => item.classList.remove('flash-green'), 1350);
}

// Event delegation: #action-label is added to #drag-space dynamically
// (either by placeStaticLabel for URL-opened windows or by the urlBar
// Enter handler for blank windows). Listening on the parent catches both
// paths without re-binding.
//
// During the redemption window (the first 5s after the URL bar is
// swapped to a label) a click on the label hands the URL bar back with
// the original input pre-filled, so the user can correct a typo. The
// page underneath keeps loading; if the redemption click was accidental,
// clicking back into the page (or pressing Esc) restores the label
// without disturbing the in-flight load. After redemption ends, clicks
// fall through to the "shake no" hint pattern.
document.getElementById('drag-space').addEventListener('click', (e) => {
  if (!e.target.closest('#action-label')) return;
  if (isRedemptionActive()) {
    softRedeem(pendingInput || '');
    return;
  }
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

// 5-second redemption: the URL bar swaps to the static action label
// *immediately* on Enter (snappy aesthetics — no editable URL bar sitting
// there for 3s). For the next 5 seconds the user can still undo the
// commit if they typed a typo: pressing Enter, Backspace, or clicking
// the label hands the URL bar back with the original input pre-filled
// so they can correct and re-submit. The previously-committed page keeps
// loading underneath — submitting a new URL aborts it mid-flight
// (startLoad re-sets src), and a click into the page or Esc dismisses
// the URL bar without touching the webview, so an accidental redemption
// click is harmless.
//
// Document-level keydown only fires when focus is on the page chrome —
// once the user clicks into the loaded page, the keystroke goes to the
// webview's guest process (separate renderer) and the redemption
// shortcut intentionally stops working.
const REDEMPTION_MS = 5000;
let redemptionTimer = null;
let pendingInput   = null;   // user's raw input, for prefill on restore
let urlBarSubmitting = false;

function isRedemptionActive() {
  return redemptionTimer !== null;
}

function startRedemption() {
  clearTimeout(redemptionTimer);
  redemptionTimer = setTimeout(endRedemption, REDEMPTION_MS);
  document.addEventListener('keydown', onRedemptionKeydown, true);
}

function endRedemption() {
  if (redemptionTimer != null) clearTimeout(redemptionTimer);
  redemptionTimer = null;
  document.removeEventListener('keydown', onRedemptionKeydown, true);
}

function onRedemptionKeydown(e) {
  if (e.key !== 'Enter' && e.key !== 'Backspace') return;
  // Skip if the user is typing into a real text field (e.g. the sticky
  // comment area in sticky-mode, or the URL bar itself if it somehow
  // got re-shown). The webview's guest renderer doesn't bubble keys up
  // to this document, so we don't need to worry about page text fields.
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  )) return;
  e.preventDefault();
  softRedeem(pendingInput || '');
}

// Soft redemption: URL bar shown in the toolbar slot while the previously-
// committed page keeps loading in the webview underneath. Unlike the
// back-button "exhausted history" path (restoreUrlBar), we don't stop the
// webview or navigate to about:blank — actionVerb/actionLabel/
// currentLoadedUrl are preserved so dismissing the URL bar can pop the
// label back without a reload. Dismiss is either Esc inside the URL bar
// or focus moving into the webview (user clicked on the page).
let softRedemptionActive = false;

function softRedeem(prefill) {
  // The static 5s timer is for "click the label to recover the URL bar".
  // Once the user has engaged with the URL bar, no longer in that window.
  endRedemption();
  softRedemptionActive = true;

  const label = document.getElementById('action-label');
  if (label) label.remove();

  const parent = document.getElementById('drag-space');
  urlBar.disabled = false;
  urlBar.value = prefill || '';
  urlBar.hidden = false;
  if (!urlBar.isConnected) {
    urlBar.classList.add('leaving');
    parent.appendChild(urlBar);
    void urlBar.offsetWidth;  // force reflow with .leaving applied
    urlBar.classList.remove('leaving');
  } else {
    urlBar.classList.remove('leaving');
  }
  urlBar.focus();
  if (prefill) urlBar.select();

  document.addEventListener('keydown', onSoftRedemptionKeydown, true);
  webview.addEventListener('focus', dismissSoftRedemption);
}

function onSoftRedemptionKeydown(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  dismissSoftRedemption();
}

function dismissSoftRedemption() {
  if (!softRedemptionActive) return;
  clearSoftRedemptionState();
  // Fade URL bar → label using the same swap as a fresh submit. The
  // webview is untouched: actionVerb/actionLabel/currentLoadedUrl were
  // preserved, so swapUrlBarToLabel re-renders the original label and
  // the in-flight load just keeps going.
  swapUrlBarToLabel();
}

function clearSoftRedemptionState() {
  if (!softRedemptionActive) return;
  softRedemptionActive = false;
  document.removeEventListener('keydown', onSoftRedemptionKeydown, true);
  webview.removeEventListener('focus', dismissSoftRedemption);
}

function swapUrlBarToLabel() {
  if (!urlBar.isConnected) return;
  // Disable so a stray Enter during the fade can't re-fire the handler.
  urlBar.disabled = true;
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    // Guard against a redemption restore that fired while the fade was
    // in flight — restoreUrlBar already removed .leaving and re-shown
    // the bar, so don't yank it back out.
    if (!urlBar.classList.contains('leaving')) return;
    const parent = urlBar.parentElement;
    if (urlBar.isConnected) urlBar.remove();
    urlBar.disabled = false;
    urlBar.classList.remove('leaving');
    const label = document.createElement('span');
    label.id = 'action-label';
    label.textContent = actionLabel;
    label.classList.add('entering');
    parent.appendChild(label);
    void label.offsetWidth;  // force reflow so the fade-in transitions
    label.classList.remove('entering');
    enableStickyButton();
  };
  urlBar.classList.add('leaving');
  urlBar.addEventListener('transitionend', swap, { once: true });
  setTimeout(swap, 400);
}

// Restore the blank URL-bar state: hard-reset to a clean blank window
// (prefill='') from the back button when there's no webview history
// left. Stops/unloads the previous page so media halts and the next
// navigation starts from a clean slate. The redemption flow uses
// softRedeem instead — it shows the URL bar without killing the page.
function restoreUrlBar(prefill) {
  // Guard re-entry from the did-navigate(about:blank) listener triggering
  // ourselves recursively, plus the "already blank" case (initial state
  // or a second back-press from the URL bar with empty history).
  if (!actionLabel && urlBar.isConnected && !urlBar.classList.contains('leaving')) return;
  clearSoftRedemptionState();
  endRedemption();
  urlBarSubmitting = false;
  pendingInput = null;
  const label = document.getElementById('action-label');
  if (label) label.remove();

  // Halt + unload. about:blank kills media and clears the visible page;
  // the next startLoad replaces it. did-navigate may fire for the
  // about:blank navigation, but with actionLabel cleared below the
  // back-from-about-blank listener short-circuits.
  try {
    webview.stop();
    if (currentLoadedUrl !== 'about:blank') {
      webview.setAttribute('src', 'about:blank');
    }
  } catch {}

  document.body.classList.add('blank-mode');
  actionVerb = null;
  actionLabel = null;
  currentLoadedUrl = null;
  document.title = 'Folia Browser';
  stickyBtn.disabled = true;
  urlBarShakeCount = 0;
  hideWebviewError();
  lockButton.hidden = true;
  lockShownForHostname = null;
  currentHostname = null;
  activePermissions.clear();
  updateLockIcon();

  // Re-show the URL bar. If it's still in the DOM (restored during the
  // swap fade) just reset its state; otherwise re-append with a fade-in
  // mirroring the leaving animation.
  const parent = document.getElementById('drag-space');
  urlBar.disabled = false;
  urlBar.value = prefill || '';
  urlBar.hidden = false;
  if (!urlBar.isConnected) {
    urlBar.classList.add('leaving');
    parent.appendChild(urlBar);
    void urlBar.offsetWidth;  // force reflow with .leaving applied
    urlBar.classList.remove('leaving');
  } else {
    urlBar.classList.remove('leaving');
  }
  urlBar.focus();
  if (prefill) urlBar.select();
  updateNav();
}

urlBar.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  if (urlBarSubmitting) return;
  const input = urlBar.value.trim();
  if (!input) return;
  urlBarSubmitting = true;
  pendingInput = input;
  // Drop soft-redemption listeners before re-arming: this submit replaces
  // any in-flight load (startLoad re-sets src), so the dismiss path no
  // longer applies to whatever was loading underneath.
  clearSoftRedemptionState();
  try {
    const resolved = await window.wm.resolveUrl(input);
    const { verb, text } = actionLabelInfo(input);
    actionVerb = verb;
    actionLabel = text;
    startLoad(resolved);
    swapUrlBarToLabel();
    startRedemption();
    updateNav();
  } finally {
    urlBarSubmitting = false;
  }
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

// Navigation. Back keeps going through webview history; once the stack
// is empty, one more click restores the blank URL-bar state — so the
// user can keep pressing back "all the way" and end up with a fresh
// address bar in the same window. forward is plain.
back.addEventListener('click', () => {
  if (webview.canGoBack()) {
    webview.goBack();
  } else if (actionLabel) {
    restoreUrlBar('');
  }
});
fwd.addEventListener('click',  () => webview.goForward());

function updateNav() {
  // actionLabel is the "in loaded state" flag. In blank state both
  // arrows are inert — webview is hidden behind the URL bar and the
  // about:blank sentinel restoreUrlBar leaves behind in webview history
  // would otherwise make canGoBack/canGoForward report stale truths.
  back.disabled = !actionLabel;
  fwd.disabled  = !actionLabel || !webview.canGoForward();
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
webview.addEventListener('did-fail-load', (e) => {
  progressFinish();
  showWebviewError(e);
});
webview.addEventListener('did-start-loading', hideWebviewError);

// Minimalist failure overlay. Replaces Chromium's default error page so
// the user sees a Folia-styled message in the toolbar's voice. Only the
// most common codes get bespoke copy; everything else falls back to the
// errorDescription Chromium hands us. User-initiated cancellations
// (ERR_ABORTED) and sub-resource failures (isMainFrame === false) skip
// the overlay so a clicked link that cancels mid-load doesn't blank the
// page the user is currently looking at.
const errorEl       = document.getElementById('webview-error');
const errorTitleEl  = errorEl.querySelector('.webview-error-title');
const errorDetailEl = errorEl.querySelector('.webview-error-detail');

function hostFromUrl(u) {
  try { return new URL(u).hostname; } catch { return u; }
}

function messageForFailure(evt) {
  const host = hostFromUrl(evt.validatedURL || '');
  const code = evt.errorCode;
  const desc = (evt.errorDescription || '').replace(/^net::/i, '').replace(/_/g, ' ').toLowerCase();
  if (code === -106) {
    return { title: 'No internet connection', detail: 'Check your network and try again.' };
  }
  if (code === -105 || code === -137) {
    return {
      title: `Couldn't reach ${host || 'this site'}`,
      detail: 'The address may be wrong, or your connection is offline.',
    };
  }
  if (code === -109) {
    return { title: 'Network unreachable', detail: "Your device can't reach the network right now." };
  }
  if (code === -118 || code === -7) {
    return { title: `${host || 'This site'} took too long to respond` };
  }
  if (code === -501) {
    return {
      title: "This page isn't secure",
      detail: 'The site is sending content over a plain HTTP connection.',
    };
  }
  if (code <= -200 && code >= -299) {
    return {
      title: `${host || 'This site'}'s security certificate can't be verified`,
      detail: desc,
    };
  }
  return {
    title: `Couldn't load ${host || 'this page'}`,
    detail: desc,
  };
}

function showWebviewError(evt) {
  // Skip sub-resources and user-initiated cancellations.
  if (evt.isMainFrame === false) return;
  if (evt.errorCode === -3) return;  // ERR_ABORTED
  const { title, detail } = messageForFailure(evt);
  errorTitleEl.textContent = title;
  errorDetailEl.textContent = detail || '';
  errorDetailEl.hidden = !detail;
  errorEl.hidden = false;
}

function hideWebviewError() {
  if (!errorEl.hidden) errorEl.hidden = true;
}

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
// Two parallel "rings": #download-ring in the toolbar, #sticky-download in
// the sticky overlay. body.sticky-mode hides the toolbar (and therefore
// the toolbar ring), so the sticky chip is what keeps the user informed
// while a window is parked. Both share one state machine and one click
// behaviour — every UI op iterates over `rings` so they stay in sync.
const ringEls = [
  document.getElementById('download-ring'),
  document.getElementById('sticky-download'),
].filter(Boolean);
const RING_CIRC = 2 * Math.PI * 9;

const ringState = {
  id: null,
  progress: 0,
  complete: false,
  savePath: null,
};

function setRingProgress(progress) {
  const off = String(RING_CIRC * (1 - progress));
  for (const el of ringEls) {
    const fill = el.querySelector('.fill');
    if (fill) fill.style.strokeDashoffset = off;
  }
}

function showRing(titleText) {
  ringState.complete = false;
  ringState.progress = 0;
  for (const el of ringEls) {
    el.classList.remove('complete');
    el.hidden = false;
    if (titleText) el.title = titleText;
  }
  setRingProgress(0);
}

function completeRing(titleAfter) {
  ringState.complete = true;
  for (const el of ringEls) {
    el.classList.add('complete');
    el.title = titleAfter;
  }
  setRingProgress(1);
}

function hideRing() {
  for (const el of ringEls) {
    el.hidden = true;
    el.classList.remove('complete');
  }
  ringState.id = null;
  ringState.complete = false;
  ringState.savePath = null;
}

window.wm.onDownload((evt) => {
  if (evt.kind === 'started') {
    showRing(`Downloading ${evt.filename}…`);
    ringState.id = evt.id;
    ringState.savePath = null;
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

function handleRingClick(el) {
  if (!ringState.complete) {
    el.classList.remove('shake-red');
    void el.offsetWidth;  // restart animation if already running
    el.classList.add('shake-red');
    setTimeout(() => el.classList.remove('shake-red'), 400);
    return;
  }
  if (ringState.savePath) {
    window.wm.showDownloadInFolder(ringState.savePath);
  }
  hideRing();
}

for (const el of ringEls) {
  el.addEventListener('click', () => handleRingClick(el));
}

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

// Cross-fade duration when restoring from sticky. Kept in sync with the
// opacity transition on #sticky-overlay.fading-out in style.css so the
// timeout that hides the overlay fires right as the fade completes.
const STICKY_FADE_MS = 260;

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

  // If the user has text selected on the page when they click sticky,
  // seed the comment with the selection — a frictionless "quote the
  // thing I wanted to remember" gesture. Only prefill when the comment
  // is empty: don't clobber a comment that's already been typed across
  // previous shrink cycles (the overlay stays in the DOM, so its text
  // persists across sticky/restore round-trips within a window's life).
  if (!(stickyComment.textContent || '').trim()) {
    try {
      const selection = await webview.executeJavaScript('window.getSelection().toString()');
      const trimmed = (selection || '').trim();
      if (trimmed) stickyComment.textContent = trimmed;
    } catch {}
  }

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
  // Reveal the toolbar+webview underneath the still-opaque overlay, then
  // cross-fade the overlay out. The .fading-out class transitions opacity
  // 1 → 0 so the page appears through the sticky instead of snapping in.
  // Without this two-step the user sees the window grow, then a hard cut
  // from sticky-yellow to the page — visually jarring.
  document.body.classList.remove('sticky-mode');
  stickyOverlay.classList.add('fading-out');
  // Lazy-restored stickies carry a deferredUrl: the webview was created
  // src-less so we need to startLoad now that the window is full size.
  // Defer-loading from a still-shrunken webview triggers the
  // layout-too-small bug guarded by startLoad's setTimeout(50ms). Kick
  // the load off while the overlay is fading so the blank → page paint
  // lands underneath the cross-fade.
  if (result?.deferredUrl) {
    startLoad(result.deferredUrl);
  }
  setTimeout(() => {
    stickyOverlay.hidden = true;
    stickyOverlay.classList.remove('fading-out');
  }, STICKY_FADE_MS);
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

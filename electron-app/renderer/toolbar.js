const webview     = document.getElementById('content');
const back        = document.getElementById('back');
const fwd         = document.getElementById('fwd');
const progressBar = document.getElementById('progress-bar');
const urlBar      = document.getElementById('url-bar');

// Tag <body> with the platform so CSS can branch (e.g. hide HTML window
// controls on macOS, where native traffic lights live in the titlebar).
document.body.classList.add('platform-' + (window.wm?.platform || 'unknown'));

const initialUrl = decodeURIComponent(location.hash.slice(1));
const isBlank    = !initialUrl;

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
function startLoad(url) {
  let hostname = 'default';
  try { hostname = new URL(url).hostname; } catch {}
  webview.setAttribute('partition', 'persist:' + hostname);

  const fire = () => webview.setAttribute('src', url);
  if (document.readyState === 'complete') {
    setTimeout(fire, 50);
  } else {
    window.addEventListener('load', () => setTimeout(fire, 50));
  }
}

// Build the static action label that replaces the URL bar after the user
// commits a search. Mirrors main.js's resolveUrl() heuristic so the label
// matches what actually got loaded.
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
    return `visited ${host}`.toLowerCase();
  }
  return `searched for '${trimmed}'`.toLowerCase();
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
document.getElementById('menu').addEventListener('click',     () => window.wm.showContextMenu());

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

// Webview preload — runs in the guest renderer's isolated world. Wraps
// getUserMedia and the geolocation APIs in the page's main world so the
// toolbar's lock icon can show "in use" while a stream/watch is live, and
// "idle" again the moment the page releases it.
//
// Cross-world bridge: the wrappers live in the page's main world (so the
// page actually sees the overrides), and they pass state changes to this
// preload via window.postMessage. We then forward to the host renderer via
// ipcRenderer.sendToHost. CSP on the page can block inline <script>
// injection, so we use webFrame.executeJavaScript which runs as if from
// the preload's privileges and bypasses page CSP.

const { ipcRenderer, webFrame } = require('electron');

const MAIN_WORLD_SOURCE = `
(() => {
  if (window.__foliaPermissionWrapped) return;
  window.__foliaPermissionWrapped = true;

  const send = (kind, active) => {
    window.postMessage({ __foliaPerm: true, kind, active }, '*');
  };

  // ---- Camera + microphone (live MediaStreamTrack tracking) ----
  const liveTracks = { camera: new Set(), microphone: new Set() };
  const update = (kind) => send(kind, liveTracks[kind].size > 0);

  const trackKind = (track) => (track.kind === 'audio' ? 'microphone' : 'camera');

  const watchTrack = (track) => {
    const kind = trackKind(track);
    const set = liveTracks[kind];
    if (set.has(track)) return;
    set.add(track);
    update(kind);

    const release = () => {
      if (!set.delete(track)) return;
      update(kind);
    };
    track.addEventListener('ended', release);

    // .stop() doesn't fire 'ended' — wrap it so manual stops are caught too.
    const origStop = track.stop.bind(track);
    track.stop = function () {
      origStop();
      release();
    };
  };

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = function (constraints) {
      return orig(constraints).then((stream) => {
        for (const t of stream.getTracks()) watchTrack(t);
        return stream;
      });
    };
  }

  // ---- Geolocation (active during pending one-shot or live watch) ----
  const liveWatches = new Set();
  let pendingOneShots = 0;
  const updateGeo = () => send('geolocation', liveWatches.size > 0 || pendingOneShots > 0);

  const geo = navigator.geolocation;
  if (geo) {
    const origGet = geo.getCurrentPosition.bind(geo);
    geo.getCurrentPosition = function (success, error, options) {
      pendingOneShots++;
      updateGeo();
      const done = () => { pendingOneShots--; updateGeo(); };
      origGet(
        (pos) => { done(); if (success) try { success(pos); } catch (_) {} },
        (err) => { done(); if (error)   try { error(err); }  catch (_) {} },
        options,
      );
    };

    const origWatch = geo.watchPosition.bind(geo);
    geo.watchPosition = function (success, error, options) {
      const id = origWatch(success, error, options);
      liveWatches.add(id);
      updateGeo();
      return id;
    };

    const origClear = geo.clearWatch.bind(geo);
    geo.clearWatch = function (id) {
      origClear(id);
      if (liveWatches.delete(id)) updateGeo();
    };
  }
})();
`;

webFrame.executeJavaScript(MAIN_WORLD_SOURCE).catch(() => {});

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const data = e.data;
  if (!data || data.__foliaPerm !== true) return;
  ipcRenderer.sendToHost('folia-permission-active', { kind: data.kind, active: !!data.active });
});

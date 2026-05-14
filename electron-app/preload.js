const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wm', {
  platform:        process.platform,
  close:           () => ipcRenderer.send('wm-close'),
  toggleMaximize:  () => ipcRenderer.send('wm-maximize'),
  // Sticky-note minimize. shrink/restore resolve once main has finished
  // animating the bounds, so the renderer can sequence "focus the comment
  // area" after the shrink completes. shrinkToSticky takes a {url, verb,
  // label, comment} payload so main can persist the sticky for next-launch
  // restoration. restoreFromSticky resolves to {deferredUrl} — non-null
  // when the sticky was lazy-restored from disk, signalling the renderer
  // to startLoad the URL after the grow animation. newWindowFromSticky
  // cascades off the pre-shrink bounds (handled in main).
  shrinkToSticky:      (payload) => ipcRenderer.invoke('wm-sticky-shrink', payload),
  restoreFromSticky:   () => ipcRenderer.invoke('wm-sticky-restore'),
  newWindowFromSticky: () => ipcRenderer.send('wm-sticky-new-window'),
  // Renderer pushes comment edits live (debounced) so the persisted file
  // tracks every typed character without main having to poll.
  updateStickyComment: (comment) => ipcRenderer.send('wm-sticky-update-comment', comment),
  // First-render bootstrap. Returns {lazy: false} for fresh windows; for a
  // lazy-restored sticky returns {lazy: true, url, verb, label, comment}
  // so the renderer can paint the overlay without loading the URL.
  getInitState:        () => ipcRenderer.invoke('get-init-state'),
  // Main fires this when the WM's dblclick-maximize gesture lands on a
  // sticky — we re-route it through the same path as the maximize-square
  // button to keep the size-drift / corner-snap workarounds in one place.
  onStickyRestoreRequested: (handler) => {
    const fn = () => handler();
    ipcRenderer.on('sticky-restore-requested', fn);
    return () => ipcRenderer.removeListener('sticky-restore-requested', fn);
  },
  // Settings broadcast. Main pushes the full settings object on every
  // save so any renderer (e.g. the sticky-zoom CSS variable) can react
  // live without polling.
  onSettingsChanged: (handler) => {
    const fn = (_e, settings) => handler(settings);
    ipcRenderer.on('settings-changed', fn);
    return () => ipcRenderer.removeListener('settings-changed', fn);
  },
  getSettings:     () => ipcRenderer.invoke('get-settings'),
  saveSettings:    (s) => ipcRenderer.send('settings-save', s),
  getAppVersion:   () => ipcRenderer.invoke('get-app-version'),
  resolveUrl:      (input) => ipcRenderer.invoke('resolve-url', input),
  deleteCookies:   () => ipcRenderer.invoke('delete-cookies'),
  deleteCache:     () => ipcRenderer.invoke('delete-cache'),
  // Toolbar ⋮ menu. Renderer renders a custom HTML popover and asks main
  // for `{hasPage, url}` to disable items that need a loaded page, then
  // dispatches the chosen action by name.
  getAppMenuState: () => ipcRenderer.invoke('get-app-menu-state'),
  appMenuAction:   (action) => ipcRenderer.send('app-menu-action', action),
  // Downloads
  getDefaultDownloadPath: () => ipcRenderer.invoke('default-download-path'),
  pickDownloadFolder:     () => ipcRenderer.invoke('pick-download-folder'),
  showDownloadInFolder:   (savePath) => ipcRenderer.send('show-download-in-folder', savePath),
  onDownload: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on('download-event', fn);
    return () => ipcRenderer.removeListener('download-event', fn);
  },
  // HTML5 fullscreen state from the guest (YouTube etc.). True while the
  // page has an element in :fullscreen; renderer hides chrome to match.
  onHtmlFullscreen: (handler) => {
    const fn = (_e, isFs) => handler(isFs);
    ipcRenderer.on('html-fullscreen', fn);
    return () => ipcRenderer.removeListener('html-fullscreen', fn);
  },
  // Audio-state changes from the guest webContents (audio-state-changed).
  // Used by the sticky-note speaker indicator. true = audible, false = not.
  onAudioState: (handler) => {
    const fn = (_e, audible) => handler(audible);
    ipcRenderer.on('audio-state', fn);
    return () => ipcRenderer.removeListener('audio-state', fn);
  },
  // Per-window colour: main computes a CSS colour string (pastel hsl when
  // assigned a hue, or a literal sticky-note lock colour like #FFFFE0) and
  // pushes it via window-color. null = no tint (default grey toolbar).
  notifyNavigated: (hostname) => ipcRenderer.send('window-navigated', hostname),
  getWindowColor:  () => ipcRenderer.invoke('get-window-color'),
  onWindowColor: (handler) => {
    const fn = (_e, color) => handler(color);
    ipcRenderer.on('window-color', fn);
    return () => ipcRenderer.removeListener('window-color', fn);
  },
  // Permission UI bridge. Main fires `permission-request` with
  // {id, kinds: ['camera'|'microphone'|'geolocation'][], hostname}; the
  // toolbar shows a prompt and replies via respondPermissionRequest.
  // getPermissionGrants/setPermissionGrant power the manage-mode popover.
  onPermissionRequest: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on('permission-request', fn);
    return () => ipcRenderer.removeListener('permission-request', fn);
  },
  respondPermissionRequest: (id, allow, remember) =>
    ipcRenderer.send('permission-response', { id, allow, remember }),
  getPermissionGrants: (hostname) =>
    ipcRenderer.invoke('get-permission-grants', hostname),
  setPermissionGrant: (hostname, kind, value) =>
    ipcRenderer.send('set-permission-grant', { hostname, kind, value }),
  // Screen-picker (getDisplayMedia). Picker renderer pulls the source list
  // on load; clicking Share sends back the chosen id, Cancel/close sends
  // null. Main owns the original DesktopCapturerSource objects.
  screenPickerGetSources: () => ipcRenderer.invoke('screen-picker-get-sources'),
  screenPickerSelect: (id) => ipcRenderer.send('screen-picker-result', id),
});

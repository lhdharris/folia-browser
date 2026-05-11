const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wm', {
  platform:        process.platform,
  close:           () => ipcRenderer.send('wm-close'),
  minimize:        () => ipcRenderer.send('wm-minimize'),
  toggleMaximize:  () => ipcRenderer.send('wm-maximize'),
  getSettings:     () => ipcRenderer.invoke('get-settings'),
  saveSettings:    (s) => ipcRenderer.send('settings-save', s),
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
  // Pastel hue: main process assigns per-window hues so multiple open
  // windows get distinguishable colours. null = no tint (default grey).
  notifyNavigated: (hostname) => ipcRenderer.send('window-navigated', hostname),
  getWindowHue:    () => ipcRenderer.invoke('get-window-hue'),
  onHueChanged: (handler) => {
    const fn = (_e, hue) => handler(hue);
    ipcRenderer.on('hue-changed', fn);
    return () => ipcRenderer.removeListener('hue-changed', fn);
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

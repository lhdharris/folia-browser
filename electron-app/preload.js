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
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  // Downloads
  getDefaultDownloadPath: () => ipcRenderer.invoke('default-download-path'),
  pickDownloadFolder:     () => ipcRenderer.invoke('pick-download-folder'),
  showDownloadInFolder:   (savePath) => ipcRenderer.send('show-download-in-folder', savePath),
  onDownload: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on('download-event', fn);
    return () => ipcRenderer.removeListener('download-event', fn);
  },
});

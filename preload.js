const { contextBridge, ipcRenderer } = require('electron');

const widgetArg = process.argv.find(a => a.startsWith('--pulse-widget-id='));

contextBridge.exposeInMainWorld('pulse', {
  widgetId: widgetArg ? widgetArg.split('=')[1] : null,
  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openUsagePage: () => ipcRenderer.invoke('open-usage-page'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  pinWidget: (kind) => ipcRenderer.invoke('pin-widget', kind),
  widgetConfig: (id) => ipcRenderer.invoke('widget-config', id),
  widgetClose: (id) => ipcRenderer.invoke('widget-close', id),
  widgetBoundsGet: (id) => ipcRenderer.invoke('widget-bounds-get', id),
  widgetBoundsSet: (b) => ipcRenderer.invoke('widget-bounds-set', b),
  widgetDragEnd: (id) => ipcRenderer.invoke('widget-drag-end', id),
  widgetTop: (p) => ipcRenderer.invoke('widget-top', p),
  dashMin: () => ipcRenderer.invoke('dash-min'),
  dashClose: () => ipcRenderer.invoke('dash-close'),
  onUsage: (cb) => ipcRenderer.on('usage', (e, u) => cb(u)),
  onWidgets: (cb) => ipcRenderer.on('widgets', (e, w) => cb(w)),
  onSettings: (cb) => ipcRenderer.on('settings', (e, s) => cb(s))
});

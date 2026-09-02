const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qifuDesktop', {
  initialState: () => ipcRenderer.invoke('desktop:initial-state'),
  login: (account, password, remember) => ipcRenderer.invoke('desktop:login', { account, password, remember }),
  gatewayRequest: (path, init) => ipcRenderer.invoke('desktop:gateway-request', {
    path,
    method: init && init.method,
    body: init && init.body,
  }),
  runtimeInfo: () => ipcRenderer.invoke('desktop:runtime-info'),
  switchRuntime: (target) => ipcRenderer.invoke('desktop:switch-runtime', target),
  openFeature: (feature) => ipcRenderer.invoke('desktop:open-feature', feature),
  syncFile: () => ipcRenderer.invoke('desktop:sync-file'),
  syncSession: (sessionId, title) => ipcRenderer.invoke('desktop:sync-session', { sessionId, title }),
  onStatus: (listener) => {
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('desktop:status', wrapped);
    return () => ipcRenderer.removeListener('desktop:status', wrapped);
  },
});

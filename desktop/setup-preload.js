// The only thing the setup page may do is hand one string back to the main
// process. No other Node or Electron surface is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commons', {
  setServer: (url) => ipcRenderer.send('commons:server', String(url)),
});

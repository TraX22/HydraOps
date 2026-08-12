const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("splash", {
  onProgress: (callback) => ipcRenderer.on("splash:progress", (_event, text) => callback(text)),
});

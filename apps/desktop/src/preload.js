/**
 * preload.js — puente mínimo entre el main process y la UI de Angular.
 *
 * Solo se expone lo necesario para vigilar la pila desde la vista Sistema.
 * Nada de `require` ni acceso a Node desde el renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hydraDesktop", {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  services: {
    list: () => ipcRenderer.invoke("services:list"),
    logs: (id) => ipcRenderer.invoke("services:logs", id),
    restart: (id) => ipcRenderer.invoke("services:restart", id),
    onStatus: (callback) => {
      const listener = (_event, entry) => callback(entry);
      ipcRenderer.on("services:status", listener);
      return () => ipcRenderer.removeListener("services:status", listener);
    },
  },
});

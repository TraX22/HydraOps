/**
 * preload.js — puente mínimo entre el main process y la UI de Angular.
 *
 * Solo se expone lo necesario para vigilar la pila desde la vista Sistema y
 * para que la barra lateral muestre y aplique las actualizaciones.
 * Nada de `require` ni acceso a Node desde el renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hydraDesktop", {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  // Idioma de la UI → menú nativo y ventana Acerca de.
  setLang: (lang) => ipcRenderer.send("ui:lang", lang),
  // Tray and login-item preferences (Config view). `set` takes a partial
  // object of booleans and returns the full settings.
  settings: {
    get: () => ipcRenderer.invoke("shell:settings:get"),
    set: (patch) => ipcRenderer.invoke("shell:settings:set", patch),
  },
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
  // The installed app's updater (electron-updater), for the sidebar's update
  // block: its state (checking, downloading with progress, downloaded, up to
  // date, error; `unsupported` when not packaged), a silent re-check, and the
  // restart that installs a downloaded version.
  updater: {
    get: () => ipcRenderer.invoke("updater:get"),
    check: () => ipcRenderer.invoke("updater:check"),
    restart: () => ipcRenderer.invoke("updater:restart"),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("updater:state", listener);
      return () => ipcRenderer.removeListener("updater:state", listener);
    },
  },
});

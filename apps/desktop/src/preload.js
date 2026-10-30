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
  // The browser panel beside the chat: real Chromium tabs that the main process draws
  // over the area the chat reserves. The UI reports that area (`bounds`), whether the
  // panel may be on screen (`shown`), and drives the tabs; the state comes back whole.
  browser: {
    state: () => ipcRenderer.invoke("browser:state"),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("browser:state", listener);
      return () => ipcRenderer.removeListener("browser:state", listener);
    },
    bounds: (rect) => ipcRenderer.send("browser:bounds", rect),
    shown: (shown) => ipcRenderer.send("browser:shown", !!shown),
    // The panel is open in the UI: the shell restores or creates the tabs (not before).
    panel: (open) => ipcRenderer.send("browser:panel", !!open),
    background: (color) => ipcRenderer.send("browser:background", color),
    newTab: (url) => ipcRenderer.invoke("browser:tab:new", url ?? ""),
    closeTab: (id) => ipcRenderer.invoke("browser:tab:close", id),
    activate: (id) => ipcRenderer.invoke("browser:tab:activate", id),
    navigate: (id, input) => ipcRenderer.invoke("browser:tab:navigate", id, input),
    back: (id) => ipcRenderer.invoke("browser:tab:back", id),
    forward: (id) => ipcRenderer.invoke("browser:tab:forward", id),
    reload: (id) => ipcRenderer.invoke("browser:tab:reload", id),
    stop: (id) => ipcRenderer.invoke("browser:tab:stop", id),
    setVisibility: (id, visibility) => ipcRenderer.invoke("browser:tab:visibility", id, visibility),
    openExternal: (id) => ipcRenderer.invoke("browser:tab:external", id),
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

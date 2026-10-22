/**
 * updater.js — actualizaciones automáticas del escritorio con electron-updater.
 *
 * Flujo, pensado para no molestar: al arrancar (y solo en la app empaquetada)
 * pregunta a la Release de GitHub si hay versión nueva; si la hay, la descarga
 * en segundo plano. Lo que pasa se publica como un ESTADO (`getState`,
 * `onStateChange`) que main.js reenvía a la ventana: la barra lateral de la UI
 * muestra "descargando 63 %" y, cuando está lista, el botón "Reiniciar e
 * instalar", que llama a `restartToInstall`. Ya no salta ningún diálogo: el
 * usuario decide cuándo, y si cierra la app la versión descargada se instala
 * igual (autoInstallOnAppQuit). Nunca interrumpe a media tarea.
 *
 * Además del chequeo de arranque, vuelve a comprobar cada 6 horas: pensado para
 * un HydraOps encendido 24/7, que si no nunca se enteraría de una versión nueva
 * porque solo miraría una vez. El menú y la UI también pueden forzar una
 * comprobación.
 *
 * El instalador no está firmado aún: electron-updater verifica la descarga por
 * su SHA512 (el del latest.yml que sube electron-builder), no por firma, así
 * que la actualización es válida igualmente. La configuración de dónde mirar
 * (github TraX22/HydraOps) viaja dentro del app-update.yml que genera
 * electron-builder desde el bloque publish.
 */
const { app, dialog } = require("electron");

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
// Una comprobación lanzada desde el menú SÍ avisa del resultado ("ya estás al
// día" / "no se pudo comprobar"); las de fondo y las de la UI son silenciosas:
// la UI ya muestra el resultado en su bloque.
let manualCheckPending = false;
let logFn = () => {};

/**
 * What the UI shows. `status`: idle (nothing known yet) · checking · available
 * (found, download starting) · downloading (percent, transferred, total bytes)
 * · downloaded (ready to install: `version`) · up-to-date (`checkedAt`) ·
 * error (`error`) · unsupported (not packaged: updates come through git).
 */
let state = { status: app.isPackaged ? "idle" : "unsupported", version: null, current: app.getVersion() };
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch, current: app.getVersion(), at: Date.now() };
  for (const fn of listeners) {
    try { fn(state); } catch { /* a listener never breaks the updater */ }
  }
}

function getState() { return state; }

function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function runCheck() {
  if (!autoUpdater) return;
  // A download in flight or finished is not re-checked: the result would be the same.
  if (state.status === "downloading" || state.status === "downloaded") return;
  setState({ status: "checking", error: null });
  autoUpdater.checkForUpdates().catch((err) => {
    logFn(`updater: comprobación falló (${err?.message || err})`);
    setState({ status: "error", error: String(err?.message || err) });
    notifyManual({
      type: "warning",
      message: "No se pudo comprobar si hay actualizaciones.",
      detail: String(err?.message || err),
    });
  });
}

// Si la comprobación venía del menú, muestra el resultado y baja la bandera.
function notifyManual(box) {
  if (!manualCheckPending) return;
  manualCheckPending = false;
  dialog.showMessageBox({
    title: "HydraOps",
    buttons: ["Aceptar"],
    defaultId: 0,
    ...box,
  });
}

function initAutoUpdate(shellLog) {
  logFn = shellLog || logFn;

  // En desarrollo no hay app-update.yml ni versión publicada: no aplica.
  if (!app.isPackaged) return;

  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    logFn(`updater: electron-updater no disponible (${err.message})`);
    autoUpdater = null;
    setState({ status: "error", error: "electron-updater no disponible" });
    return;
  }

  // La descarga la disparamos nosotros al encontrar versión; el reinicio, el
  // usuario. Así nada ocurre a su espalda.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => logFn(`updater: ${m}`),
    warn: (m) => logFn(`updater WARN: ${m}`),
    error: (m) => logFn(`updater ERROR: ${m}`),
    debug: () => {},
  };

  autoUpdater.on("update-available", (info) => {
    logFn(`updater: versión ${info.version} disponible, descargando…`);
    manualCheckPending = false;
    setState({ status: "available", version: info.version, percent: 0, transferred: 0, total: 0 });
  });

  autoUpdater.on("download-progress", (p) => {
    setState({ status: "downloading", percent: Math.round(p.percent || 0), transferred: p.transferred || 0, total: p.total || 0 });
  });

  autoUpdater.on("update-not-available", () => {
    logFn("updater: ya está en la última versión");
    setState({ status: "up-to-date", version: null, checkedAt: Date.now() });
    notifyManual({
      type: "info",
      message: "Ya tienes la última versión de HydraOps.",
      detail: `Versión ${app.getVersion()}.`,
    });
  });

  autoUpdater.on("error", (err) => {
    // Sin conexión o sin releases todavía: no es un fallo de la app, solo se
    // anota. Nada de diálogos de error por no poder comprobar actualizaciones.
    logFn(`updater: no se pudo comprobar (${err?.message || err})`);
    setState({ status: "error", error: String(err?.message || err) });
    notifyManual({
      type: "warning",
      message: "No se pudo comprobar si hay actualizaciones.",
      detail: String(err?.message || err),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    // Lista: la barra lateral ofrece "Reiniciar e instalar"; nada salta solo.
    logFn(`updater: ${info.version} descargada, la UI ofrece el reinicio`);
    setState({ status: "downloaded", version: info.version, percent: 100 });
  });

  // Un respiro tras el arranque para no competir con el encendido de la pila,
  // y luego cada 6 horas para un HydraOps que no se reinicia.
  setTimeout(runCheck, 8000);
  setInterval(runCheck, SIX_HOURS_MS);
}

/**
 * Comprobación a demanda desde el menú. A diferencia de las de fondo, esta
 * siempre le dice algo al usuario: que ya está al día, que hay una descargando,
 * o que no se pudo comprobar.
 */
function checkForUpdatesNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info",
      title: "HydraOps",
      message: "Las actualizaciones automáticas solo funcionan en la aplicación instalada.",
      detail: "En modo desarrollo se actualiza con git.",
      buttons: ["Aceptar"],
    });
    return;
  }
  if (!autoUpdater) {
    dialog.showMessageBox({
      type: "warning",
      title: "HydraOps",
      message: "El actualizador no está disponible.",
      buttons: ["Aceptar"],
    });
    return;
  }
  manualCheckPending = true;
  runCheck();
}

/** A check asked from the UI: silent, the sidebar shows what comes back. */
function checkQuietly() {
  if (!autoUpdater) return getState();
  manualCheckPending = false;
  runCheck();
  return getState();
}

/** The user pressed "Restart and install": only when a version is downloaded. */
function restartToInstall() {
  if (!autoUpdater || state.status !== "downloaded") return false;
  logFn(`updater: reinicio pedido desde la UI para instalar ${state.version}`);
  // quitAndInstall cierra la ventana; el before-quit del main para la pila
  // de servicios limpiamente antes de que arranque el instalador.
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
}

module.exports = { initAutoUpdate, checkForUpdatesNow, checkQuietly, restartToInstall, getState, onStateChange };

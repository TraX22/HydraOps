/**
 * updater.js — actualizaciones automáticas del escritorio con electron-updater.
 *
 * Flujo, pensado para no molestar: al arrancar (y solo en la app empaquetada)
 * pregunta a la Release de GitHub si hay versión nueva; si la hay, la descarga
 * en segundo plano y, cuando está lista, ofrece un diálogo "Reiniciar ahora /
 * Más tarde". Nunca interrumpe a media tarea ni reinicia sin permiso.
 *
 * Además del chequeo de arranque, vuelve a comprobar cada 6 horas: pensado para
 * un HydraOps encendido 24/7, que si no nunca se enteraría de una versión nueva
 * porque solo miraría una vez. El menú también puede forzar una comprobación.
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
// día" / "no se pudo comprobar"); las de fondo son silenciosas.
let manualCheckPending = false;
let logFn = () => {};

function runCheck() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => {
    logFn(`updater: comprobación falló (${err?.message || err})`);
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
    // Encontrada: el aviso al usuario lo dará el diálogo de "descargada".
    manualCheckPending = false;
  });

  autoUpdater.on("update-not-available", () => {
    logFn("updater: ya está en la última versión");
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
    notifyManual({
      type: "warning",
      message: "No se pudo comprobar si hay actualizaciones.",
      detail: String(err?.message || err),
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    logFn(`updater: ${info.version} descargada, ofreciendo reinicio`);
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "HydraOps",
      message: `Hay una versión nueva (${info.version}) lista para instalar.`,
      detail: "Se aplicará al reiniciar la aplicación. Tus datos y tus claves no se tocan.",
      buttons: ["Reiniciar ahora", "Más tarde"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      // quitAndInstall cierra la ventana; el before-quit del main para la pila
      // de servicios limpiamente antes de que arranque el instalador.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
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

module.exports = { initAutoUpdate, checkForUpdatesNow };

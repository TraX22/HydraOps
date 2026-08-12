/**
 * updater.js — actualizaciones automáticas del escritorio con electron-updater.
 *
 * Flujo, pensado para no molestar: al arrancar (y solo en la app empaquetada)
 * pregunta a la Release de GitHub si hay versión nueva; si la hay, la descarga
 * en segundo plano y, cuando está lista, ofrece un diálogo "Reiniciar ahora /
 * Más tarde". Nunca interrumpe a media tarea ni reinicia sin permiso.
 *
 * El instalador no está firmado aún: electron-updater verifica la descarga por
 * su SHA512 (el del latest.yml que sube electron-builder), no por firma, así
 * que la actualización es válida igualmente. La configuración de dónde mirar
 * (github TraX22/HydraOps) viaja dentro del app-update.yml que genera
 * electron-builder desde el bloque publish.
 */
const { app, dialog } = require("electron");

function initAutoUpdate(shellLog) {
  // En desarrollo no hay app-update.yml ni versión publicada: no aplica.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    shellLog(`updater: electron-updater no disponible (${err.message})`);
    return;
  }

  // La descarga la disparamos nosotros al encontrar versión; el reinicio, el
  // usuario. Así nada ocurre a su espalda.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => shellLog(`updater: ${m}`),
    warn: (m) => shellLog(`updater WARN: ${m}`),
    error: (m) => shellLog(`updater ERROR: ${m}`),
    debug: () => {},
  };

  autoUpdater.on("update-available", (info) => {
    shellLog(`updater: versión ${info.version} disponible, descargando…`);
  });

  autoUpdater.on("update-not-available", () => {
    shellLog("updater: ya está en la última versión");
  });

  autoUpdater.on("error", (err) => {
    // Sin conexión o sin releases todavía: no es un fallo de la app, solo se
    // anota. Nada de diálogos de error por no poder comprobar actualizaciones.
    shellLog(`updater: no se pudo comprobar (${err?.message || err})`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    shellLog(`updater: ${info.version} descargada, ofreciendo reinicio`);
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

  // Un respiro tras el arranque para no competir con el encendido de la pila.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      shellLog(`updater: comprobación falló (${err?.message || err})`);
    });
  }, 8000);
}

module.exports = { initAutoUpdate };

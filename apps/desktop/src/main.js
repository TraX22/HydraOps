/**
 * main.js — proceso principal del shell de escritorio de HydraOps.
 *
 * Ciclo de vida: splash → arrancar la pila (services.js) → servir la UI
 * compilada → mostrar la ventana. Al cerrar, para los procesos que lanzamos.
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Un fallo en el proceso principal cierra la aplicación sin dejar rastro: la
 * ventana nunca llega a abrirse y en Windows no hay consola donde ver el error.
 * Esto lo deja por escrito para poder diagnosticarlo.
 */
function writeCrashLog(err) {
  const text = `[${new Date().toISOString()}] ${err?.stack || err}\n`;
  for (const dir of [safeUserData(), os.tmpdir()]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hydraops-crash.log"), text);
      return path.join(dir, "hydraops-crash.log");
    } catch { /* probamos el siguiente */ }
  }
  return null;
}

function safeUserData() {
  try { return app.getPath("userData"); } catch { return null; }
}

/**
 * Traza del arranque del propio shell. Los servicios ya escriben sus logs, pero
 * si algo falla antes de que exista el supervisor no queda nada; esto sí.
 */
function shellLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const dir = path.join(safeUserData() || os.tmpdir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "shell.log"), line);
  } catch { /* sin log, seguimos */ }
}

process.on("uncaughtException", (err) => {
  const where = writeCrashLog(err);
  try {
    dialog.showErrorBox(
      "HydraOps",
      `Error inesperado:\n${err?.message || err}` + (where ? `\n\nDetalle en:\n${where}` : "")
    );
  } catch { /* si ni el diálogo va, al menos queda el archivo */ }
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  writeCrashLog(reason instanceof Error ? reason : new Error(String(reason)));
});

const { ServiceSupervisor, REPO_ROOT, SEED_ROOT, UI_ROOT } = require("./services");
const { ensureDataDir } = require("./data-dir");
const { initAutoUpdate } = require("./updater");

const UI_DIST = UI_ROOT;
const APP_ICON = path.join(__dirname, "..", "build", "icon.png");
const DEV_UI_URL = process.env.HYDRA_DEV_UI_URL || ""; // p.ej. http://localhost:4200

/**
 * Reparto de %APPDATA%\HydraOps en una instalación:
 *
 *   keys.json   el almacén del cortafuegos de credenciales; lo pone y lo lee
 *               el key-proxy, y nadie más debe tocarlo (ojo: Windows no
 *               distingue mayúsculas, así que %APPDATA%\hydraops del
 *               key-proxy y %APPDATA%\HydraOps son la MISMA carpeta).
 *   shell\      estado interno de Electron (caché, localStorage) y los logs
 *               del supervisor.
 *   data\       lo del usuario: base de datos, agentes, perfil, adjuntos,
 *               add-ons y .env.
 *
 * Hay que fijarlo a mano porque Electron deduce userData del campo "name" del
 * package.json, que aquí es "@hydraops/desktop" y produce una ruta anidada
 * absurda; y dejarlo en %APPDATA%\HydraOps a secas mezclaría los datos con
 * keys.json.
 */
const APP_DATA_HOME = path.join(app.getPath("appData"), "HydraOps");
if (app.isPackaged) {
  app.setPath("userData", path.join(APP_DATA_HOME, "shell"));
}

/**
 * Dónde viven los datos del usuario.
 *
 * Instalado: %APPDATA%\HydraOps\data, que es escribible; el directorio de
 * instalación no tiene por qué serlo. En desarrollo: la raíz del repositorio,
 * exactamente donde han estado siempre, para no partir el flujo de trabajo ni
 * tener que mover nada a mano. HYDRA_DATA_DIR fuerza cualquiera de los dos
 * casos (útil para probar el sembrado sin empaquetar).
 */
function resolveDataRoot() {
  if (process.env.HYDRA_DATA_DIR) return path.resolve(process.env.HYDRA_DATA_DIR);
  return app.isPackaged ? path.join(APP_DATA_HOME, "data") : REPO_ROOT;
}

let dataRoot = REPO_ROOT;
let supervisor = null;
let mainWindow = null;
let splashWindow = null;

shellLog(`arranque: packaged=${app.isPackaged} exe=${process.execPath}`);

if (!app.requestSingleInstanceLock()) {
  shellLog("ya hay otra instancia con el bloqueo; salimos");
  app.quit();
  return;
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: "#1b1b2f",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "splash-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
}

function splashMessage(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("splash:progress", text);
  }
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#ffffff",
    title: "HydraOps",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    splashWindow = null;
    mainWindow.show();
  });

  // Los enlaces externos van al navegador del sistema, nunca a una ventana
  // de Electron con acceso al preload.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(url);
}

function buildMenu() {
  const template = [
    {
      label: "HydraOps",
      submenu: [
        {
          label: "Recargar interfaz",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: "Herramientas de desarrollo",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: "separator" },
        {
          label: "Abrir carpeta de logs",
          click: () => shell.openPath(path.join(app.getPath("userData"), "logs")),
        },
        { type: "separator" },
        { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Deshacer" },
        { role: "redo", label: "Rehacer" },
        { type: "separator" },
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Pegar" },
        { role: "selectAll", label: "Seleccionar todo" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "resetZoom", label: "Zoom normal" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle("services:list", () => supervisor.snapshot());
  ipcMain.handle("services:logs", (_event, id) => supervisor.logsFor(id));
  ipcMain.handle("services:restart", (_event, id) => supervisor.restart(id));
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    repoRoot: REPO_ROOT,
    dataRoot,
    logDir: path.join(app.getPath("userData"), "logs"),
  }));
}

async function boot() {
  shellLog("app lista, mostrando splash");
  createSplash();
  buildMenu();

  dataRoot = resolveDataRoot();
  shellLog(`raíces: datos=${dataRoot} backend=${REPO_ROOT} ui=${UI_DIST}`);
  try {
    await ensureDataDir({
      dataRoot,
      seedRoot: SEED_ROOT,
      repoRoot: REPO_ROOT,
      isPackaged: app.isPackaged,
      onProgress: splashMessage,
    });
  } catch (err) {
    shellLog(`fallo preparando los datos: ${err.message}`);
    dialog.showErrorBox(
      "HydraOps",
      `No se pudo preparar el directorio de datos:\n${dataRoot}\n\n${err.message}`
    );
    app.quit();
    return;
  }
  shellLog("datos listos, arrancando servicios");

  supervisor = new ServiceSupervisor({
    logDir: path.join(app.getPath("userData"), "logs"),
    dataRoot,
    isPackaged: app.isPackaged,
  });
  supervisor.on("status", (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("services:status", entry);
    }
  });
  registerIpc();

  try {
    await supervisor.startAll(splashMessage);
  } catch (err) {
    dialog.showErrorBox("HydraOps", `No se pudo arrancar la pila:\n${err.message}`);
  }

  // La interfaz la sirve la propia API, en el mismo origen que los datos. Antes
  // había aquí un servidor estático en un puerto efímero, pero eso obligaba a la
  // interfaz a llamar a la API por una dirección absoluta — justo lo que impedía
  // abrirla desde otro equipo de la red.
  let url = DEV_UI_URL;
  if (!url) {
    splashMessage("Cargando interfaz…");
    if (!fs.existsSync(path.join(UI_DIST, "index.html"))) {
      dialog.showErrorBox(
        "HydraOps",
        `Falta el build de la interfaz.\n\nEjecuta:\n  pnpm --dir ui build\n\nEsperaba encontrarlo en:\n${UI_DIST}`
      );
      app.quit();
      return;
    }
    url = "http://127.0.0.1:3000";
  }

  createMainWindow(url);

  // Comprueba actualizaciones en segundo plano (solo empaquetada); si hay una,
  // la descarga y ofrece reiniciar. No bloquea el arranque.
  initAutoUpdate(shellLog);
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  app.quit();
});

let cleanedUp = false;
app.on("before-quit", (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  (async () => {
    if (supervisor) await supervisor.stopAll();
    app.quit();
  })();
});

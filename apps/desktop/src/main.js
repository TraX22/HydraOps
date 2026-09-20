/**
 * main.js — proceso principal del shell de escritorio de HydraOps.
 *
 * Ciclo de vida: splash → arrancar la pila (services.js) → servir la UI
 * compilada → mostrar la ventana. Al cerrar, para los procesos que lanzamos.
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require("electron");
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

const { ServiceSupervisor, REPO_ROOT, UI_ROOT } = require("./services");
const { ensureDataDir } = require("./data-dir");
const { initAutoUpdate, checkForUpdatesNow } = require("./updater");
const shellI18n = require("./i18n");

// Idioma del menú nativo y de la ventana Acerca de. Arranca en el mismo por
// defecto que la UI (en); se ajusta al leer `hydra_lang` del renderer al cargar
// y cada vez que el usuario lo cambia (IPC `ui:lang`).
let currentLang = "en";

const GITHUB_URL = "https://github.com/TraX22/HydraOps";
const WEBSITE_URL = "https://hydraops.org";
const X_URL = "https://x.com/HydraOpsApp";

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
let tray = null;

// ─── Shell settings: tray, launch at login ───────────────────────────────────
// Closing the window used to quit everything — API, NATS, workers, the Telegram
// bot — which is exactly what a 24/7 setup must not do. By default the window
// now hides to the system tray and the stack keeps running; Quit is explicit
// (tray menu or app menu). Settings live in the shell's own user-data folder,
// not in the app database: they belong to this machine, not to the data set.
const SHELL_SETTINGS_FILE = () => path.join(app.getPath("userData"), "shell-settings.json");
const DEFAULT_SHELL_SETTINGS = { closeToTray: true, launchAtLogin: false, startInTray: false };
let shellSettings = { ...DEFAULT_SHELL_SETTINGS };

function loadShellSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHELL_SETTINGS_FILE(), "utf8"));
    shellSettings = { ...DEFAULT_SHELL_SETTINGS, ...raw };
  } catch { /* first run: defaults */ }
  return shellSettings;
}

function saveShellSettings(patch) {
  shellSettings = { ...shellSettings, ...patch };
  try {
    fs.mkdirSync(path.dirname(SHELL_SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SHELL_SETTINGS_FILE(), JSON.stringify(shellSettings, null, 2));
  } catch (err) {
    shellLog(`no se pudo guardar shell-settings.json: ${err.message}`);
  }
  applyLoginItem();
  buildTrayMenu();
  return shellSettings;
}

// Registers (or removes) HydraOps in the user's login items. Only for the
// packaged app: in development the executable is Electron itself and
// registering it would launch a bare Electron at login.
const START_IN_TRAY_ARG = "--start-in-tray";
function applyLoginItem() {
  if (!app.isPackaged) {
    shellLog(`inicio con el sistema: ignorado en desarrollo (launchAtLogin=${shellSettings.launchAtLogin})`);
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: !!shellSettings.launchAtLogin,
      path: process.execPath,
      args: shellSettings.launchAtLogin && shellSettings.startInTray ? [START_IN_TRAY_ARG] : [],
    });
    shellLog(`inicio con el sistema: ${shellSettings.launchAtLogin ? "activado" : "desactivado"}${shellSettings.startInTray ? " (en bandeja)" : ""}`);
  } catch (err) {
    shellLog(`inicio con el sistema: fallo al registrar: ${err.message}`);
  }
}

// Why the app is quitting, for shell.log: every exit path sets it before
// app.quit() so a "the app disappeared" report can be read back in seconds.
let quitting = false;
let quitReason = "";
const startInTray = process.argv.includes(START_IN_TRAY_ARG);

function quitApp(reason) {
  quitReason = reason;
  quitting = true;
  app.quit();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Safety net: if the window ever sits on something that is not the app, bring it home.
  const current = mainWindow.webContents.getURL();
  if (appUrl && current && !isAppUrl(current) && !current.startsWith("file:")) {
    shellLog(`la ventana estaba fuera de la app (${current.slice(0, 120)}): volviendo a la interfaz`);
    mainWindow.loadURL(appUrl);
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

let trayNoticeShown = false;
function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(APP_ICON);
  tray = new Tray(process.platform === "darwin" ? icon.resize({ width: 18, height: 18 }) : icon);
  tray.setToolTip("HydraOps");
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const t = shellI18n.t(currentLang).tray;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.open, click: () => showMainWindow() },
    { type: "separator" },
    {
      label: t.closeToTray,
      type: "checkbox",
      checked: !!shellSettings.closeToTray,
      click: (item) => saveShellSettings({ closeToTray: item.checked }),
    },
    {
      label: t.launchAtLogin,
      type: "checkbox",
      checked: !!shellSettings.launchAtLogin,
      click: (item) => saveShellSettings({ launchAtLogin: item.checked }),
    },
    {
      label: t.startInTray,
      type: "checkbox",
      checked: !!shellSettings.startInTray,
      enabled: !!shellSettings.launchAtLogin,
      click: (item) => saveShellSettings({ startInTray: item.checked }),
    },
    { type: "separator" },
    { label: t.quit, click: () => quitApp("menú de la bandeja: Salir") },
  ]));
}

shellLog(`arranque: packaged=${app.isPackaged} exe=${process.execPath}`);

if (!app.requestSingleInstanceLock()) {
  shellLog("ya hay otra instancia con el bloqueo; salimos");
  app.quit();
  return;
}

app.on("second-instance", () => {
  // A second launch (Start menu, login item) brings the running one back.
  showMainWindow();
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

// ── Navigation guard ────────────────────────────────────────────────────────
// The main window only ever shows HydraOps. It carries the preload bridge, so an
// outside page must never load in it — and a user who clicked a link in a chat
// must not end up trapped on a website with no way back. Anything that is not
// the app's own origin opens in the system browser instead.
let appUrl = "";
let availabilityTimer = null;

function isAppUrl(target) {
  try { return new URL(target).origin === new URL(appUrl).origin; } catch { return false; }
}

function openInBrowser(target) {
  try {
    const u = new URL(target);
    if (["http:", "https:", "mailto:"].includes(u.protocol)) shell.openExternal(u.toString());
  } catch { /* not a URL: ignore */ }
}

// The app's page could not be loaded (the API is not up): say so instead of a
// blank window, keep probing, and come back by ourselves when it answers.
function showUnavailable() {
  if (!mainWindow || mainWindow.isDestroyed() || availabilityTimer) return;
  const t = shellI18n.t(currentLang).unavailable;
  shellLog("la interfaz no responde: mostrando la página de espera y sondeando");
  mainWindow.loadFile(path.join(__dirname, "unavailable.html"), { query: { title: t.title, body: t.body, hint: t.hint } });
  availabilityTimer = setInterval(() => {
    const req = require("node:http").get(appUrl, { timeout: 2000 }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode < 500) {
        clearInterval(availabilityTimer);
        availabilityTimer = null;
        shellLog("la interfaz volvió a responder: recargando");
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(appUrl);
      }
    });
    req.on("error", () => { /* still down */ });
    req.on("timeout", () => req.destroy());
  }, 3000);
}

function createMainWindow(url) {
  appUrl = url;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#1b1b2f",
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
    if (startInTray) {
      shellLog("arranque en la bandeja: ventana oculta");
      return;
    }
    mainWindow.show();
  });

  // The X hides the window to the tray unless the user turned that off (or
  // is quitting for real). Windows fires session-end on logoff/shutdown.
  mainWindow.on("close", (event) => {
    if (quitting || !shellSettings.closeToTray) {
      if (!quitting) shellLog("ventana cerrada con la X (bandeja desactivada): se cierra la aplicación");
      return;
    }
    event.preventDefault();
    mainWindow.hide();
    shellLog("ventana ocultada a la bandeja (cierre con la X); la pila sigue corriendo");
    if (!trayNoticeShown && tray && process.platform === "win32") {
      trayNoticeShown = true;
      const t = shellI18n.t(currentLang).tray;
      try { tray.displayBalloon({ title: "HydraOps", content: t.stillRunning, iconType: "info" }); } catch { /* no balloon support */ }
    }
  });
  mainWindow.on("session-end", () => {
    quitReason = "cierre de sesión o apagado de Windows";
    quitting = true;
  });

  // Los enlaces externos van al navegador del sistema, nunca a una ventana
  // de Electron con acceso al preload.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    openInBrowser(target);
    return { action: "deny" };
  });
  // A plain link (no target="_blank") would navigate THIS window. Keep it on the app.
  const keepOnApp = (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    shellLog(`navegación externa bloqueada en la ventana principal: ${String(target).slice(0, 200)} → navegador del sistema`);
    openInBrowser(target);
  };
  mainWindow.webContents.on("will-navigate", keepOnApp);
  mainWindow.webContents.on("will-redirect", keepOnApp);
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, _desc, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (a navigation we cancelled ourselves)
    if (isMainFrame && errorCode !== -3 && isAppUrl(validatedURL)) showUnavailable();
  });

  // Idioma persistido de la UI: lo leemos en cuanto carga para que el menú
  // nazca ya en el idioma correcto, incluso antes de que Angular avise por IPC.
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents
      .executeJavaScript("localStorage.getItem('hydra_lang')")
      .then((lang) => setShellLang(lang))
      .catch(() => { /* sin acceso: se queda en el por defecto */ });
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(url);
}

/**
 * Ventana "Acerca de": logo, nombre + versión, una descripción breve y tres
 * botones con icono — Sitio web (logo de la marca), GitHub y X — que abren el
 * enlace en el navegador del sistema. Es una ventana HTML propia (no el diálogo
 * nativo) porque sus botones sí admiten iconos SVG, como el resto de la app.
 */
let aboutWindow = null;
function showAbout() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 440,
    height: 560,
    parent: mainWindow ?? undefined,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Acerca de HydraOps",
    backgroundColor: "#1b1b2f",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  // Los enlaces (target=_blank) van al navegador del sistema, nunca a una
  // ventana de Electron.
  aboutWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  aboutWindow.once("ready-to-show", () => aboutWindow.show());
  aboutWindow.on("closed", () => { aboutWindow = null; });
  const a = shellI18n.t(currentLang).about;
  aboutWindow.setTitle(a.title);
  aboutWindow.loadFile(path.join(__dirname, "about.html"), {
    query: {
      lang: currentLang,
      v: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      website: WEBSITE_URL,
      github: GITHUB_URL,
      x: X_URL,
      title: a.title,
      versionLabel: a.versionLabel,
      description: a.description,
      apache: a.apache,
      websiteLabel: a.website,
      closeLabel: a.close,
    },
  });
}

function buildMenu() {
  const m = shellI18n.t(currentLang).menu;
  const template = [
    {
      label: "HydraOps",
      submenu: [
        {
          label: m.updates,
          click: () => checkForUpdatesNow(),
        },
        { type: "separator" },
        {
          label: m.reload,
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: m.devtools,
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: "separator" },
        {
          label: m.openLogs,
          click: () => shell.openPath(path.join(app.getPath("userData"), "logs")),
        },
        { type: "separator" },
        { label: m.quit, accelerator: "CmdOrCtrl+Q", click: () => quitApp("menú de la aplicación: Salir") },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: "undo", label: m.undo },
        { role: "redo", label: m.redo },
        { type: "separator" },
        { role: "cut", label: m.cut },
        { role: "copy", label: m.copy },
        { role: "paste", label: m.paste },
        { role: "selectAll", label: m.selectAll },
      ],
    },
    {
      label: m.view,
      submenu: [
        { role: "resetZoom", label: m.resetZoom },
        { role: "zoomIn", label: m.zoomIn },
        { role: "zoomOut", label: m.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: m.fullscreen },
      ],
    },
    {
      // Menú de primer nivel, junto a "Ver": al pulsarlo abre la ventana
      // directamente (no despliega submenú).
      label: m.about,
      click: () => showAbout(),
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Ajusta el idioma del menú/Acerca de al que trae la UI. Lo llama el IPC
 * `ui:lang` (cambio del usuario) y la lectura inicial de `hydra_lang`.
 */
function setShellLang(lang) {
  if (!lang || lang === currentLang || !shellI18n.LANGS.includes(lang)) return;
  currentLang = lang;
  buildMenu();
  buildTrayMenu();
}

function registerIpc() {
  // La UI avisa del idioma elegido (al arrancar y al cambiarlo) para que el
  // menú nativo y el Acerca de lo respeten.
  ipcMain.on("ui:lang", (_event, lang) => setShellLang(lang));
  ipcMain.handle("services:list", () => supervisor.snapshot());
  ipcMain.handle("services:logs", (_event, id) => supervisor.logsFor(id));
  ipcMain.handle("services:restart", (_event, id) => supervisor.restart(id));
  // Tray / login-item preferences, edited from the Config view.
  ipcMain.handle("shell:settings:get", () => ({ ...shellSettings, canLaunchAtLogin: app.isPackaged }));
  ipcMain.handle("shell:settings:set", (_event, patch) => {
    const clean = {};
    for (const key of ["closeToTray", "launchAtLogin", "startInTray"]) {
      if (typeof patch?.[key] === "boolean") clean[key] = patch[key];
    }
    return { ...saveShellSettings(clean), canLaunchAtLogin: app.isPackaged };
  });
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
  loadShellSettings();
  shellLog(`app lista${startInTray ? " (arranque en bandeja)" : ", mostrando splash"}; bandeja=${shellSettings.closeToTray} inicio=${shellSettings.launchAtLogin}`);
  if (!startInTray) createSplash();
  buildMenu();

  dataRoot = resolveDataRoot();
  shellLog(`raíces: datos=${dataRoot} backend=${REPO_ROOT} ui=${UI_DIST}`);
  try {
    await ensureDataDir({
      dataRoot,
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

  // HYDRA_SHELL_NO_SERVICES=1 skips the stack: for working on the shell itself
  // (tray, menus, windows) against an already running HydraOps, without
  // spawning a second set of workers on the same NATS.
  if (process.env.HYDRA_SHELL_NO_SERVICES) {
    shellLog("servicios omitidos (HYDRA_SHELL_NO_SERVICES)");
  } else {
    try {
      await supervisor.startAll(splashMessage);
    } catch (err) {
      dialog.showErrorBox("HydraOps", `No se pudo arrancar la pila:\n${err.message}`);
    }
  }

  // Autoactualización desde código (checkout de git): la API encola la petición
  // cuando el usuario pulsa "Actualizar" y aquí se ejecuta git+rebuild y se
  // reinician los servicios, recargando la ventana al final. En el instalador
  // (packaged) no aplica — ahí actualiza electron-updater.
  if (!app.isPackaged) {
    const { watchForUpdateRequest } = require("./self-update");
    watchForUpdateRequest({
      repoRoot: REPO_ROOT,
      dataRoot,
      stopAll: () => supervisor.stopAll(),
      startAll: () => supervisor.startAll(splashMessage),
      afterStart: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); },
    });
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
  createTray();

  // Comprueba actualizaciones en segundo plano (solo empaquetada); si hay una,
  // la descarga y ofrece reiniciar. No bloquea el arranque.
  initAutoUpdate(shellLog);
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  // Only reached when the window really closed (tray off, or quitting).
  if (!quitReason) quitReason = "última ventana cerrada";
  quitting = true;
  app.quit();
});

let cleanedUp = false;
app.on("before-quit", (event) => {
  // Anything that calls app.quit() directly (the updater's quitAndInstall,
  // the OS) lands here without a reason; say so instead of staying silent.
  quitting = true;
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  shellLog(`cerrando la aplicación: ${quitReason || "app.quit() sin motivo declarado (actualización o sistema)"}`);
  (async () => {
    if (supervisor) await supervisor.stopAll();
    if (tray) { tray.destroy(); tray = null; }
    shellLog("pila detenida; fin");
    app.quit();
  })();
});

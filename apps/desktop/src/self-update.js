/**
 * self-update.js — autoactualización de la instalación DESDE CÓDIGO.
 *
 * Reutilizado por el supervisor headless (tools/serve.mjs) y por el de
 * escritorio (main.js). La API sólo ESCRIBE una petición (self-update.request en
 * dataRoot) cuando el usuario pulsa "Actualizar"; aquí se vigila ese archivo y,
 * al aparecer, se hace: git fetch + checkout de la tag + pnpm install + rebuild
 * (con los servicios AÚN vivos — en Linux reemplazar archivos abiertos es
 * seguro), y sólo al final un breve stop → migraciones → start para cargar el
 * código nuevo. Si el rebuild falla, no se para nada: la app sigue en la versión
 * anterior y el error queda en el estado.
 *
 * NO aplica al instalador de Windows (tiene su propio updater; además esa
 * instalación no es un checkout de git y la API rechaza la petición).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const requestFile = (dataRoot) => path.join(dataRoot, "self-update.request");
const stateFile = (dataRoot) => path.join(dataRoot, "self-update.state.json");

function readState(dataRoot) {
  try { return JSON.parse(fs.readFileSync(stateFile(dataRoot), "utf8")); }
  catch { return { status: "idle" }; }
}
function writeState(dataRoot, state) {
  try { fs.writeFileSync(stateFile(dataRoot), JSON.stringify(state)); } catch { /* best-effort */ }
}

// Ejecuta un comando capturando su salida; resuelve con el código de salida.
function run(cmd, args, cwd, onLog) {
  return new Promise((resolve) => {
    onLog(`\n$ ${cmd} ${args.join(" ")}\n`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      onLog(`  (no se pudo ejecutar ${cmd}: ${e.message})\n`);
      return resolve(-1);
    }
    child.stdout.on("data", (c) => onLog(String(c)));
    child.stderr.on("data", (c) => onLog(String(c)));
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", (e) => { onLog(`  (error: ${e.message})\n`); resolve(-1); });
  });
}

// git fetch + checkout de la tag + install + build. Servicios siguen vivos.
// Devuelve { ok, error }. Deja el estado en "restarting" si va bien.
async function runBuild({ repoRoot, dataRoot, tag }) {
  const startedAt = Date.now();
  let log = "";
  const onLog = (chunk) => {
    log += chunk;
    if (log.length > 200000) log = log.slice(-150000);
    writeState(dataRoot, { status: "running", tag, log, startedAt });
  };
  const steps = [
    ["git", ["fetch", "--tags", "--force", "origin"]],
    ["git", ["-c", "advice.detachedHead=false", "checkout", `tags/${tag}`]],
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["build"]],
    ["pnpm", ["--filter", "ui", "build"]],
  ];
  for (const [cmd, args] of steps) {
    const code = await run(cmd, args, repoRoot, onLog);
    if (code !== 0) {
      const error = `Falló: ${cmd} ${args.join(" ")} (código ${code})`;
      writeState(dataRoot, { status: "error", tag, log, error, startedAt, finishedAt: Date.now() });
      return { ok: false, error, log };
    }
  }
  writeState(dataRoot, { status: "restarting", tag, log, startedAt });
  return { ok: true, log };
}

// Migraciones idempotentes (por si el update trae esquema nuevo). Durante el
// breve stop de los servicios, con la base libre.
function runMigrations({ repoRoot, dataRoot, onLog }) {
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return run(process.execPath, [tsxCli, path.join(repoRoot, "packages", "db", "src", "migrate.ts")], repoRoot, onLog || (() => {}));
}

/**
 * Vigila el archivo de petición. Al aparecer: rebuild (servicios vivos) →
 * stopAll → migraciones → startAll → afterStart (recargar la ventana en
 * escritorio). Devuelve una función para cancelar el vigilante.
 */
function watchForUpdateRequest({ repoRoot, dataRoot, stopAll, startAll, afterStart }) {
  const file = requestFile(dataRoot);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !fs.existsSync(file)) return;
    let req;
    try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    busy = true;
    try { fs.unlinkSync(file); } catch { /* ya no está */ }
    try {
      const built = await runBuild({ repoRoot, dataRoot, tag: req.tag });
      if (!built.ok) return; // el estado ya quedó en "error"; los servicios siguen vivos
      let log = built.log;
      const onLog = (c) => { log += c; writeState(dataRoot, { status: "restarting", tag: req.tag, log }); };
      await stopAll();
      await runMigrations({ repoRoot, dataRoot, onLog });
      await startAll();
      if (afterStart) { try { await afterStart(); } catch { /* recarga best-effort */ } }
      writeState(dataRoot, { status: "success", tag: req.tag, log, finishedAt: Date.now() });
    } catch (e) {
      const st = readState(dataRoot);
      writeState(dataRoot, { ...st, status: "error", error: String((e && e.message) || e), finishedAt: Date.now() });
    } finally {
      busy = false;
    }
  }, 3000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { requestFile, stateFile, readState, writeState, runBuild, runMigrations, watchForUpdateRequest };

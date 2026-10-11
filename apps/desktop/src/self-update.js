/**
 * self-update.js — self-update of an installation FROM SOURCE.
 *
 * Shared by the headless supervisor (tools/serve.mjs) and the desktop one
 * (main.js). The API only WRITES a request (self-update.request in dataRoot)
 * when the user presses "Update"; here that file is watched and, when it
 * appears, this runs: git fetch + checkout of the tag + pnpm install + rebuild
 * (with the services STILL alive — on Linux replacing open files is safe), and
 * only at the end a short stop so the new code loads. If the rebuild fails,
 * nothing is stopped: the app stays on the previous version and the error is
 * left in the state.
 *
 * The supervisor itself is also old code after the rebuild, and it keeps the
 * old modules (services.js among them) in memory: relaunching the services
 * from it would run the new services under the old supervisor, reporting the
 * old version. So when the caller gives a `relaunch` function the stack is
 * stopped and the supervisor is handed over to a fresh process (see
 * relaunchMode / reexecSupervisor); the new one marks the update as finished
 * once it is up (finishRelaunch). Without `relaunch` the old in-place
 * stop → migrate → start is kept.
 *
 * It does NOT apply to the Windows installer (it has its own updater; besides,
 * that installation is not a git checkout and the API rejects the request).
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

// Runs a command capturing its output; resolves with the exit code. git and pnpm
// go through the shell (on Windows pnpm is a .cmd); a path to an executable must
// not, or a folder with a space in it ("Program Files") breaks the command line.
function run(cmd, args, cwd, onLog, { shell = true } = {}) {
  return new Promise((resolve) => {
    onLog(`\n$ ${cmd} ${args.join(" ")}\n`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      onLog(`  (could not run ${cmd}: ${e.message})\n`);
      return resolve(-1);
    }
    child.stdout.on("data", (c) => onLog(String(c)));
    child.stderr.on("data", (c) => onLog(String(c)));
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", (e) => { onLog(`  (error: ${e.message})\n`); resolve(-1); });
  });
}

// git fetch + checkout of the tag + install + build. The services stay alive.
// Returns { ok, error }. Leaves the state in "restarting" when it goes well.
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

// Idempotent migrations (in case the update brings a new schema), run during
// the short stop of the services, with the database free.
async function runMigrations({ repoRoot, dataRoot, onLog }) {
  const log = onLog || (() => {});
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const code = await run(process.execPath, [tsxCli, path.join(repoRoot, "packages", "db", "src", "migrate.ts")], repoRoot, log, { shell: false });
  if (code !== 0) log(`\n(migrations exited with code ${code}: check the output above; the services start anyway)\n`);
  return code;
}

/**
 * How a headless supervisor hands itself over after an update. Under systemd
 * (which sets INVOCATION_ID) the cleanest way is to exit and let the unit's
 * Restart= bring up a new process; anywhere else (a `pnpm serve` in a
 * terminal) a fresh supervisor is started in place and the old one waits for it.
 */
const RELAUNCH_EXIT_CODE = 3;
function relaunchMode(env = process.env) {
  return env.INVOCATION_ID ? "systemd" : "reexec";
}

/**
 * Starts a new supervisor process with the same script and stays as a thin
 * waiter: the terminal output is shared, Ctrl+C and SIGTERM are forwarded,
 * and this process exits with the child's code. Returns the child.
 */
function reexecSupervisor({ script, args = [], env = process.env }) {
  const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env, windowsHide: true });
  const forward = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}

/**
 * Called by a supervisor once its stack is up: if it was started to replace one
 * that just updated, the update is now finished and the UI can reload. Returns
 * true when it closed such an update.
 */
function finishRelaunch(dataRoot) {
  const st = readState(dataRoot);
  if (st.status !== "restarting" || !st.relaunch) return false;
  const { relaunch, ...rest } = st;
  writeState(dataRoot, { ...rest, status: "success", finishedAt: Date.now() });
  return true;
}

/**
 * Watches the request file. When it appears: rebuild (services alive) → stopAll
 * → then either `relaunch` (a new supervisor takes over and finishes the state
 * itself) or migrations → startAll → afterStart (reload the window on the
 * desktop). `build` is only replaced by tests. Returns a function that cancels
 * the watcher.
 */
function watchForUpdateRequest({ repoRoot, dataRoot, stopAll, startAll, afterStart, relaunch, build = runBuild }) {
  const file = requestFile(dataRoot);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !fs.existsSync(file)) return;
    let req;
    try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    busy = true;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    try {
      const built = await build({ repoRoot, dataRoot, tag: req.tag });
      if (!built.ok) return; // the state is already "error"; the services stay alive
      let log = built.log;
      await stopAll();
      if (relaunch) {
        writeState(dataRoot, { status: "restarting", tag: req.tag, log, relaunch: true });
        await relaunch();
        return;
      }
      const onLog = (c) => { log += c; writeState(dataRoot, { status: "restarting", tag: req.tag, log }); };
      await runMigrations({ repoRoot, dataRoot, onLog });
      await startAll();
      if (afterStart) { try { await afterStart(); } catch { /* best-effort reload */ } }
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

module.exports = {
  requestFile, stateFile, readState, writeState, runBuild, runMigrations, watchForUpdateRequest,
  RELAUNCH_EXIT_CODE, relaunchMode, reexecSupervisor, finishRelaunch,
};

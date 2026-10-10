/**
 * services.js — supervisor of the HydraOps stack for the desktop shell.
 *
 * Starts and watches the backend processes (NATS, key-proxy, API,
 * orchestrator, outbox-worker, the 4 workers and the Telegram bot) in phases:
 * each phase waits for its services to answer before launching the next one.
 *
 * Two important decisions:
 *  - The children run with the Node THAT ELECTRON SHIPS (process.execPath with
 *    ELECTRON_RUN_AS_NODE=1), so the end user needs no Node installed. This
 *    requires native modules to be N-API: better-sqlite3 >= 12 is, and its
 *    prebuilt binary works as is for both runtimes despite their different
 *    ABIs (system Node 137 vs Electron 143).
 *  - If a service ALREADY answers on its port (because the user started it
 *    with start-infra.ps1), it is adopted as "external": neither relaunched
 *    nor killed on close. That way the app coexists with the usual dev flow.
 */
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

/**
 * Packaged, everything that travels with the application lives in resources/:
 * the built backend in resources/backend, the UI in resources/ui, the NATS
 * binary in resources/nats and the agent seed in resources/seed. In
 * development all of that hangs from the repository root.
 */
const PACKAGED = __dirname.includes(`app.asar${path.sep}`) || __dirname.includes("app.asar/");
const REPO = path.resolve(__dirname, "..", "..", "..");
const HOME = PACKAGED ? process.resourcesPath || "" : REPO;

/**
 * Root of the services' code. HYDRA_BACKEND_ROOT points at an already built
 * backend (build/backend) without packaging: the way to test the installation
 * path from the repository.
 */
const REPO_ROOT = process.env.HYDRA_BACKEND_ROOT
  ? path.resolve(process.env.HYDRA_BACKEND_ROOT)
  : PACKAGED
    ? path.join(HOME, "backend")
    : REPO;

/**
 * The application version lives in the desktop package.json, which is packed
 * inside the asar. Reading it relative to this file works in all three modes
 * (packaged desktop, headless and development). It is passed to the API by
 * env: in the deployed backend apps/desktop/package.json no longer exists, so
 * a direct read there would give null (and the view would not know which
 * version runs).
 */
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version || "";
  } catch { return ""; }
})();

/**
 * The NATS binary no longer has its path (or version) pinned. Lookup order:
 * explicit NATS_SERVER_BIN → the one shipped packaged → any nats-server under
 * nats/ in the repository (dev on Windows) → the PATH, which is the normal
 * case on a headless server (apt/brew/choco or the bare binary).
 */
const NATS_EXE = process.platform === "win32" ? "nats-server.exe" : "nats-server";
function resolveNatsBin() {
  const explicit = process.env.NATS_SERVER_BIN?.trim();
  if (explicit) return explicit;
  if (PACKAGED) return path.join(HOME, "nats", NATS_EXE);
  const natsDir = path.join(REPO, "nats");
  try {
    const flat = path.join(natsDir, NATS_EXE);
    if (fs.existsSync(flat)) return flat;
    for (const d of fs.readdirSync(natsDir)) {
      const candidate = path.join(natsDir, d, NATS_EXE);
      if (d.startsWith("nats-server") && fs.existsSync(candidate)) return candidate;
    }
  } catch { /* no nats/ folder: a clean clone, the PATH is searched */ }
  return NATS_EXE;
}
const NATS_BIN = resolveNatsBin();

/** Where example agents and add-ons are copied from when seeding. */
const SEED_ROOT = PACKAGED ? path.join(HOME, "seed") : REPO;

/** Where the built UI is. */
const UI_ROOT = PACKAGED
  ? path.join(HOME, "ui")
  : path.join(REPO, "ui", "dist", "ui", "browser");

/** Phase 0 starts first; within a phase the services go in parallel. */
const SERVICES = [
  { id: "nats",           label: "NATS JetStream", phase: 0, kind: "binary", port: 4222 },
  { id: "key-proxy",      label: "Key proxy",      phase: 0, kind: "node", app: "key-proxy",     port: 9099, healthPath: "/health" },
  { id: "api",            label: "API",            phase: 1, kind: "node", app: "api",           port: 3000, healthPath: "/api/tasks/health-check" },
  { id: "orchestrator",   label: "Orchestrator",   phase: 2, kind: "node", app: "orchestrator" },
  { id: "outbox-worker",  label: "Outbox worker",  phase: 2, kind: "node", app: "outbox-worker" },
  { id: "worker-coder",   label: "Worker coder",   phase: 2, kind: "node", app: "worker-coder" },
  { id: "worker-general", label: "Worker general", phase: 2, kind: "node", app: "worker-general" },
  { id: "worker-graphic", label: "Worker graphic", phase: 2, kind: "node", app: "worker-graphic" },
  { id: "worker-video",   label: "Worker video",   phase: 2, kind: "node", app: "worker-video" },
  { id: "telegram-bot",   label: "Telegram bot",   phase: 2, kind: "node", app: "telegram-bot" },
];

const MAX_LOG_LINES = 400;
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Is something already listening on this loopback port? */
function portInUse(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Which apps of the stack already have a live process, by looking at the
 * command lines of the running `node` processes.
 *
 * Done this way because orchestrator, outbox-worker and the workers listen on
 * no port: there is nothing to probe. The heartbeat they keep in the DB is no
 * use either — it outlives the process by several minutes, so a worker just
 * closed would look alive and never be relaunched.
 */
function detectRunningApps() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("ps", ["-eo", "args"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? new Set() : parseAppNames(stdout));
      });
    } else {
      // Both executables are checked: node.exe when the stack was launched with
      // the PowerShell scripts, electron.exe when another instance of the app did.
      execFile(
        "powershell",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='electron.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err ? new Set() : parseAppNames(stdout))
      );
    }
  });
}

// Only processes of THIS backend count. A developer checkout running next to the
// installed app (or a second install) is someone else's stack: adopting its API
// left the app with nothing on its own port and a blank window.
function parseAppNames(output) {
  const names = new Set();
  const root = REPO_ROOT.replace(/\\/g, "/").toLowerCase();
  const pattern = /apps[\\/]([a-z0-9-]+)[\\/](?:src|dist)[\\/]index\.(?:ts|js)/i;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.replace(/\\/g, "/").toLowerCase().includes(root)) continue;
    const match = pattern.exec(line);
    if (match) names.add(match[1].toLowerCase());
  }
  return names;
}

/** Waits for the service to answer: HTTP when it has a healthPath, TCP otherwise. */
async function waitForService(service, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.healthPath) {
      const ok = await new Promise((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port: service.port, path: service.healthPath, timeout: 1500 },
          (res) => {
            res.resume();
            resolve(res.statusCode > 0 && res.statusCode < 500);
          }
        );
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
      });
      if (ok) return true;
    } else if (await portInUse(service.port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * On Windows, killing the parent process orphans the grandchildren: taskkill /T
 * takes the whole tree.
 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      return resolve();
    }
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
  });
}

class ServiceSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.logDir    supervisor logs (the services also write
   *                                their own in <dataRoot>/storage/logs)
   * @param {string} opts.dataRoot  inherited by the children as HYDRA_DATA_DIR
   * @param {boolean} opts.isPackaged
   */
  constructor({ logDir, dataRoot, isPackaged }) {
    super();
    this.logDir = logDir;
    this.dataRoot = dataRoot || REPO_ROOT;
    this.isPackaged = isPackaged;
    this.shuttingDown = false;
    this.state = new Map();
    for (const service of SERVICES) {
      this.state.set(service.id, {
        id: service.id,
        label: service.label,
        status: "pending", // pending | starting | running | external | crashed | stopped
        pid: null,
        restarts: 0,
        detail: "",
        logs: [],
        child: null,
      });
    }
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  snapshot() {
    return [...this.state.values()].map(({ child, logs, ...rest }) => rest);
  }

  logsFor(id) {
    return this.state.get(id)?.logs.join("") ?? "";
  }

  #update(id, patch) {
    const entry = this.state.get(id);
    if (!entry) return;
    Object.assign(entry, patch);
    const { child, logs, ...pub } = entry;
    this.emit("status", pub);
  }

  #appendLog(id, chunk) {
    const entry = this.state.get(id);
    if (!entry) return;
    entry.logs.push(chunk);
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
    this.emit("log", { id, chunk });
  }

  /**
   * Command for a Node service. In development the TypeScript runs through
   * tsx; packaged, the bundle already built in dist/.
   */
  #nodeCommand(service) {
    const appDir = path.join(REPO_ROOT, "apps", service.app);
    const distEntry = path.join(appDir, "dist", "index.js");
    const srcEntry = path.join(appDir, "src", "index.ts");
    // Electron's own executable acts as Node with ELECTRON_RUN_AS_NODE=1
    const command = process.execPath;

    if (this.isPackaged || (!fs.existsSync(srcEntry) && fs.existsSync(distEntry))) {
      return { command, args: [distEntry] };
    }
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    if (!fs.existsSync(tsxCli)) {
      if (fs.existsSync(distEntry)) return { command, args: [distEntry] };
      throw new Error(`Neither tsx nor a bundle found for ${service.id}`);
    }
    return { command, args: [tsxCli, srcEntry] };
  }

  #spawnService(service) {
    // The JetStream store is user data, not code: it hangs from dataRoot
    // (which in development is the repository root itself, so it does not move).
    const natsStore = path.join(this.dataRoot, "nats", "jetstream");
    // Every service talks to NATS over loopback, and the bus has no
    // authentication: bound to 127.0.0.1 only, so nothing else on the network
    // can publish tasks into it (nats-server listens on every interface by default).
    const { command, args } =
      service.kind === "binary"
        ? { command: NATS_BIN, args: ["-a", "127.0.0.1", "-js", "-sd", natsStore] }
        : this.#nodeCommand(service);

    // HYDRA_APP_ROOT is passed explicitly because @hydraops/config infers it from
    // its own location, and in a deployed node_modules that inference is wrong.
    const env = {
      ...process.env,
      FORCE_COLOR: "0",
      HYDRA_DATA_DIR: this.dataRoot,
      HYDRA_APP_ROOT: REPO_ROOT,
      // The API serves the UI. Packaged it lives in resources/ui, unrelated to
      // the repository tree, so it has to be told.
      HYDRA_UI_DIR: UI_ROOT,
      // The installed version, for the API to show it (see APP_VERSION above).
      HYDRA_APP_VERSION: APP_VERSION,
    };
    if (service.kind === "node") {
      // Turns the Electron executable into a plain Node for the child
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      // An external binary (NATS) must not inherit it
      delete env.ELECTRON_RUN_AS_NODE;
    }

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const logStream = fs.createWriteStream(
      path.join(this.logDir, `${service.id}.log`), { flags: "a" }
    );
    const pipe = (stream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        this.#appendLog(service.id, chunk);
        logStream.write(chunk);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on("exit", (code, signal) => {
      logStream.end();
      const entry = this.state.get(service.id);
      if (!entry || entry.child !== child) return;
      entry.child = null;
      if (this.shuttingDown) {
        this.#update(service.id, { status: "stopped", pid: null, detail: "" });
        return;
      }
      this.#update(service.id, {
        status: "crashed",
        pid: null,
        detail: signal ? `terminado por ${signal}` : `salió con código ${code}`,
      });
      this.#scheduleRestart(service);
    });

    child.on("error", (err) => {
      this.#appendLog(service.id, `\n[desktop] could not launch: ${err.message}\n`);
      this.#update(service.id, { status: "crashed", pid: null, detail: err.message });
    });

    this.#update(service.id, { status: "starting", pid: child.pid, detail: "", child });
    return child;
  }

  #scheduleRestart(service) {
    const entry = this.state.get(service.id);
    if (!entry || this.shuttingDown) return;
    if (entry.restarts >= MAX_RESTARTS) {
      this.#update(service.id, { detail: `${entry.detail} — reintentos agotados` });
      return;
    }
    entry.restarts += 1;
    setTimeout(() => {
      if (this.shuttingDown) return;
      this.#appendLog(service.id, `\n[desktop] restarting (attempt ${entry.restarts})\n`);
      this.#spawnService(service);
    }, RESTART_DELAY_MS);
  }

  /** Starts everything by phases. onProgress receives messages for the splash. */
  async startAll(onProgress = () => {}) {
    const phases = [...new Set(SERVICES.map((s) => s.phase))].sort();
    // One single snapshot of the existing processes, taken before launching
    // anything: afterwards our own children would show up in the listing.
    onProgress("Buscando servicios ya en marcha…");
    const alreadyRunning = await detectRunningApps();

    for (const phase of phases) {
      const inPhase = SERVICES.filter((s) => s.phase === phase);

      for (const service of inPhase) {
        // Adopt whatever is already up instead of clashing with EADDRINUSE
        if (service.port && (await portInUse(service.port))) {
          this.#update(service.id, {
            status: "external",
            detail: `ya activo en el puerto ${service.port}`,
          });
          onProgress(`${service.label}: ya estaba en marcha`);
          continue;
        }
        // A service with a port is adopted by its port alone (checked above): a
        // same-named process that is not listening there is not serving this app.
        if (service.kind === "node" && !service.port && alreadyRunning.has(service.app)) {
          this.#update(service.id, {
            status: "external",
            detail: "ya activo (proceso existente)",
          });
          onProgress(`${service.label}: ya estaba en marcha`);
          continue;
        }
        onProgress(`Arrancando ${service.label}…`);
        try {
          this.#spawnService(service);
        } catch (err) {
          this.#update(service.id, { status: "crashed", detail: err.message });
        }
      }

      const waits = inPhase
        .filter((s) => s.port && this.state.get(s.id).status === "starting")
        .map(async (service) => {
          const ready = await waitForService(service);
          if (this.state.get(service.id).status === "starting") {
            this.#update(service.id, {
              status: ready ? "running" : "crashed",
              detail: ready ? "" : "no respondió a tiempo",
            });
          }
          return ready;
        });
      await Promise.all(waits);

      // Services without a port (workers, orchestrator) count as started when
      // they are still alive after a moment; their real health is reported by /workers.
      await sleep(400);
      for (const service of inPhase) {
        const entry = this.state.get(service.id);
        if (entry.status === "starting" && entry.child) {
          this.#update(service.id, { status: "running" });
        }
      }
    }
    onProgress("Servicios listos");
  }

  async restart(id) {
    const service = SERVICES.find((s) => s.id === id);
    const entry = this.state.get(id);
    if (!service || !entry) return false;
    if (entry.status === "external") return false;

    if (entry.child) {
      const child = entry.child;
      entry.child = null;
      await killTree(child.pid);
      await sleep(300);
    }
    entry.restarts = 0;
    this.#spawnService(service);
    if (service.port) {
      const ready = await waitForService(service, 30000);
      this.#update(id, { status: ready ? "running" : "crashed" });
    } else {
      await sleep(400);
      if (this.state.get(id).child) this.#update(id, { status: "running" });
    }
    return true;
  }

  /** Stops everything we launched ourselves; external ones are left alone. */
  async stopAll() {
    this.shuttingDown = true;
    const kills = [];
    for (const entry of this.state.values()) {
      if (entry.child) {
        kills.push(killTree(entry.child.pid));
        entry.child = null;
      }
    }
    await Promise.all(kills);
  }
}

module.exports = { ServiceSupervisor, SERVICES, REPO_ROOT, SEED_ROOT, UI_ROOT, PACKAGED, NATS_BIN };

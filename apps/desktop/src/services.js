/**
 * services.js — supervisor de la pila HydraOps para el shell de escritorio.
 *
 * Arranca y vigila los 9 procesos del backend (NATS, key-proxy, API,
 * orchestrator, outbox-worker y los 4 workers), en fases: cada fase espera a
 * que sus servicios respondan antes de lanzar la siguiente.
 *
 * Dos decisiones importantes:
 *  - Los hijos se lanzan con el Node QUE TRAE ELECTRON (process.execPath con
 *    ELECTRON_RUN_AS_NODE=1), así el usuario final no necesita Node instalado.
 *    Esto exige que los módulos nativos sean N-API: better-sqlite3 >= 12 lo es,
 *    y su binario precompilado sirve tal cual para los dos runtimes pese a
 *    tener ABIs distintos (Node del sistema 137 vs Electron 143).
 *  - Si un servicio YA responde en su puerto (porque el usuario lo arrancó con
 *    start-infra.ps1), se adopta como "externo": ni se relanza ni se mata al
 *    cerrar. Así la app convive con el flujo de desarrollo de siempre.
 */
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

/**
 * Empaquetado, todo lo que viaja con la aplicación vive en resources/: el
 * backend construido en resources/backend, la UI en resources/ui, el binario de
 * NATS en resources/nats y la semilla de agentes en resources/seed. En
 * desarrollo todo eso cuelga de la raíz del repositorio.
 */
const PACKAGED = __dirname.includes(`app.asar${path.sep}`) || __dirname.includes("app.asar/");
const REPO = path.resolve(__dirname, "..", "..", "..");
const HOME = PACKAGED ? process.resourcesPath || "" : REPO;

/**
 * Raíz del código de los servicios. HYDRA_BACKEND_ROOT permite apuntar a un
 * backend ya construido (build/backend) sin llegar a empaquetar: es la forma de
 * probar el camino de instalación desde el repositorio.
 */
const REPO_ROOT = process.env.HYDRA_BACKEND_ROOT
  ? path.resolve(process.env.HYDRA_BACKEND_ROOT)
  : PACKAGED
    ? path.join(HOME, "backend")
    : REPO;

/**
 * El binario de NATS ya no lleva la ruta (ni la versión) fijada. Orden de
 * búsqueda: NATS_SERVER_BIN explícito → el que viaja empaquetado → cualquier
 * nats-server bajo nats/ en el repositorio (dev en Windows) → el PATH, que es
 * lo normal en un servidor headless (apt/brew/choco o el binario suelto).
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
  } catch { /* sin carpeta nats/: un clon limpio, se busca en el PATH */ }
  return NATS_EXE;
}
const NATS_BIN = resolveNatsBin();

/** De dónde se copian agentes y add-ons de ejemplo al sembrar. */
const SEED_ROOT = PACKAGED ? path.join(HOME, "seed") : REPO;

/** Dónde está la UI compilada. */
const UI_ROOT = PACKAGED
  ? path.join(HOME, "ui")
  : path.join(REPO, "ui", "dist", "ui", "browser");

/** Fase 0 arranca primero; dentro de una fase los servicios van en paralelo. */
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
];

const MAX_LOG_LINES = 400;
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ¿Hay algo escuchando ya en este puerto de loopback? */
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
 * Qué apps de la pila tienen ya un proceso vivo, mirando las líneas de comando
 * de los `node` en ejecución.
 *
 * Se hizo así porque orchestrator, outbox-worker y los workers no escuchan en
 * ningún puerto: no hay nada que sondear. El heartbeat que guardan en la BD
 * tampoco sirve — sobrevive varios minutos a la muerte del proceso, así que un
 * worker recién cerrado parecería vivo y nunca lo relanzaríamos.
 */
function detectRunningApps() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("ps", ["-eo", "args"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? new Set() : parseAppNames(stdout));
      });
    } else {
      // Se miran los dos ejecutables: node.exe si la pila se lanzó con los
      // scripts de PowerShell, electron.exe si la lanzó otra instancia de la app.
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

function parseAppNames(output) {
  const names = new Set();
  const pattern = /apps[\\/]([a-z0-9-]+)[\\/](?:src|dist)[\\/]index\.(?:ts|js)/gi;
  let match;
  while ((match = pattern.exec(output)) !== null) names.add(match[1].toLowerCase());
  return names;
}

/** Espera a que el servicio responda: HTTP si tiene healthPath, TCP si no. */
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
 * En Windows, matar el proceso padre deja huérfanos a los nietos: taskkill /T
 * se lleva el árbol entero.
 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGTERM"); } catch { /* ya muerto */ }
      return resolve();
    }
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
  });
}

class ServiceSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.logDir    logs del supervisor (los servicios además
   *                                escriben los suyos en <dataRoot>/storage/logs)
   * @param {string} opts.dataRoot  se hereda a los hijos como HYDRA_DATA_DIR
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
   * Comando para un servicio Node. En desarrollo se ejecuta el TypeScript con
   * tsx; empaquetado, el bundle ya construido en dist/.
   */
  #nodeCommand(service) {
    const appDir = path.join(REPO_ROOT, "apps", service.app);
    const distEntry = path.join(appDir, "dist", "index.js");
    const srcEntry = path.join(appDir, "src", "index.ts");
    // El propio ejecutable de Electron hace de Node con ELECTRON_RUN_AS_NODE=1
    const command = process.execPath;

    if (this.isPackaged || (!fs.existsSync(srcEntry) && fs.existsSync(distEntry))) {
      return { command, args: [distEntry] };
    }
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    if (!fs.existsSync(tsxCli)) {
      if (fs.existsSync(distEntry)) return { command, args: [distEntry] };
      throw new Error(`No encuentro tsx ni un bundle para ${service.id}`);
    }
    return { command, args: [tsxCli, srcEntry] };
  }

  #spawnService(service) {
    // El almacén de JetStream es dato de usuario, no código: cuelga de dataRoot
    // (que en desarrollo es la propia raíz del repositorio, así que no se mueve).
    const natsStore = path.join(this.dataRoot, "nats", "jetstream");
    const { command, args } =
      service.kind === "binary"
        ? { command: NATS_BIN, args: ["-js", "-sd", natsStore] }
        : this.#nodeCommand(service);

    // HYDRA_APP_ROOT se pasa explícito porque @hydraops/config lo deduce de su
    // propia ubicación, y en un node_modules desplegado esa deducción no vale.
    const env = {
      ...process.env,
      FORCE_COLOR: "0",
      HYDRA_DATA_DIR: this.dataRoot,
      HYDRA_APP_ROOT: REPO_ROOT,
      // La API sirve la interfaz. Empaquetada vive en resources/ui, que no
      // guarda relación con el árbol del repositorio, así que hay que decírselo.
      HYDRA_UI_DIR: UI_ROOT,
    };
    if (service.kind === "node") {
      // Convierte el ejecutable de Electron en un Node a secas para el hijo
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      // Un binario externo (NATS) no debe heredarlo
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
      this.#appendLog(service.id, `\n[desktop] no se pudo lanzar: ${err.message}\n`);
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
      this.#appendLog(service.id, `\n[desktop] reiniciando (intento ${entry.restarts})\n`);
      this.#spawnService(service);
    }, RESTART_DELAY_MS);
  }

  /** Arranca todo por fases. onProgress recibe mensajes para el splash. */
  async startAll(onProgress = () => {}) {
    const phases = [...new Set(SERVICES.map((s) => s.phase))].sort();
    // Una sola foto de los procesos existentes, tomada antes de lanzar nada:
    // después nuestros propios hijos aparecerían en el listado.
    onProgress("Buscando servicios ya en marcha…");
    const alreadyRunning = await detectRunningApps();

    for (const phase of phases) {
      const inPhase = SERVICES.filter((s) => s.phase === phase);

      for (const service of inPhase) {
        // Adoptar lo que ya esté levantado en vez de chocar con EADDRINUSE
        if (service.port && (await portInUse(service.port))) {
          this.#update(service.id, {
            status: "external",
            detail: `ya activo en el puerto ${service.port}`,
          });
          onProgress(`${service.label}: ya estaba en marcha`);
          continue;
        }
        if (service.kind === "node" && alreadyRunning.has(service.app)) {
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

      // Los servicios sin puerto (workers, orchestrator) se dan por arrancados
      // si siguen vivos tras un instante; su salud real la reporta /workers.
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

  /** Para todo lo que hayamos lanzado nosotros; los externos se respetan. */
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

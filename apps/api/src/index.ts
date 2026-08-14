import { config as loadDotenv } from "dotenv";
import express from "express";
import cors from "cors";
import path from "node:path";
import { readdir, readFile, writeFile, mkdir, rm, access, rename } from "node:fs/promises";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import multer from "multer";

import {
  loadEnv,
  appRoot,
  agentsDir,
  usersDir,
  appsDir,
  storageDir,
  logsDir,
  uploadsDir,
  imgDir,
  docsDir,
  envFile,
  keyStoreFile,
  readLocalLlmEnv,
} from "@hydraops/config";

loadDotenv({ path: envFile });

import { createRegistry } from "@hydraops/addons";
import { createDb, events as eventsTable, outbox as outboxTable, tasks, agentConfigs, systemConfigs, cronJobs, workerStatus } from "@hydraops/db";
import { buildEnvelope } from "@hydraops/events";
import { eq, and, gte, asc, like } from "drizzle-orm";
import os from "node:os";

/**
 * Utility to check if a file exists
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "api" });

// --- file logging → storage/logs/api.log (served by GET /workers/:id/logs) ---
import { createWriteStream, mkdirSync, existsSync, readFileSync } from "node:fs";
try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
const apiLogStream = createWriteStream(path.join(logsDir, `${env.SERVICE_NAME}.log`), { flags: "a" });
for (const level of ["log", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { apiLogStream.write(`[${new Date().toISOString()}]${level === "error" ? " ERROR:" : ""} ${args.map(String).join(" ")}\n`); } catch { /* ignore */ }
    orig(...args);
  };
}

const { db, pool } = createDb(env.DATABASE_URL);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ─── Autenticación por token ─────────────────────────────────────────────────
//
// Un único token compartido (HYDRA_AUTH_TOKEN en el .env) protege la API y los
// estáticos que llevan datos (/avatars, /storage, /img, /users). El build de
// Angular queda fuera a propósito: servir el cascarón de la SPA no revela nada
// y es lo que permite pintar la pantalla de login.
//
// Las peticiones desde loopback no pagan peaje: el escritorio (Electron carga
// 127.0.0.1:3000), el supervisor y el flujo de desarrollo siguen exactamente
// igual. Quien pueda originar tráfico loopback en esta máquina ya puede leer
// el disco entero, así que exigirle token no añadiría seguridad real. La
// excepción es un proxy inverso delante de la API — ahí TODO el tráfico parece
// loopback y hay que poner HYDRA_AUTH_STRICT=1 para que el token se exija
// también a esas peticiones.
//
// La sesión del navegador es una cookie HttpOnly con SameSite=Strict: los
// <img> de avatares y adjuntos la mandan solos por ser mismo origen, y una web
// ajena abierta en el mismo navegador no puede disparar la API con ella (CSRF).
// Para scripts y curl vale también `Authorization: Bearer <token>`.

const AUTH_COOKIE = "hydra_auth";
const authToken = process.env.HYDRA_AUTH_TOKEN?.trim() || "";
const authStrict = process.env.HYDRA_AUTH_STRICT?.trim() === "1";

if (authToken && authToken.length < 16) {
  console.warn("[api] ⚠ HYDRA_AUTH_TOKEN tiene menos de 16 caracteres — usa uno largo y aleatorio");
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

// Comparación en tiempo constante: el hash previo iguala longitudes, que es lo
// que timingSafeEqual exige, sin filtrar en cuánto tarda dónde difieren.
function tokenMatches(candidate: string | undefined): boolean {
  if (!authToken || !candidate) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(authToken).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(req: express.Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function requestAuthState(req: express.Request): { required: boolean; authenticated: boolean } {
  const exempt = !authStrict && isLoopbackAddress(req.socket.remoteAddress);
  if (exempt) return { required: false, authenticated: true };
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const authenticated = tokenMatches(bearer) || tokenMatches(cookieValue(req, AUTH_COOKIE));
  return { required: true, authenticated };
}

const PROTECTED_PREFIXES = ["/api", "/avatars", "/storage", "/img", "/users"];
// /api/login es la puerta y /api/auth/status es lo que la UI pregunta para
// saber si debe enseñarla — ninguna de las dos puede estar detrás del muro.
const AUTH_EXEMPT_PATHS = new Set(["/api/login", "/api/auth/status"]);

app.use((req, res, next) => {
  const p = req.path;
  const guarded = PROTECTED_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
  if (!guarded || AUTH_EXEMPT_PATHS.has(p)) return next();
  if (requestAuthState(req).authenticated) return next();
  res.status(401).json({ error: "Authentication required" });
});

/**
 * Toda la API cuelga de /api, y no de la raíz, porque la raíz es de la interfaz.
 * Cinco nombres chocarían si no: /agents, /config, /system, /stats y /tasks son
 * a la vez ruta de Angular y ruta REST, así que servir ambas cosas desde el
 * mismo origen sin prefijo haría que recargar la página de Agentes devolviera
 * JSON en vez de la aplicación.
 *
 * El router se registra más abajo, DESPUÉS de las rutas: en Express el orden de
 * declaración manda, y el fallback de la SPA tiene que ser el último de todos.
 */
const api = express.Router();

// --- Auth Endpoints ---

// Cupo de intentos fallidos por IP: sin él, un token flojo se adivina a fuerza
// bruta desde la red en segundos. En memoria a propósito — reiniciar la API lo
// vacía y no pasa nada.
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 5 * 60_000;

api.post("/login", async (req, res) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const fails = loginFailures.get(ip);
  if (fails && fails.resetAt > now && fails.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: "Too many attempts, try again later" });
  }

  const candidate = typeof req.body?.token === "string" ? req.body.token : "";
  if (!tokenMatches(candidate)) {
    const cur = fails && fails.resetAt > now ? fails : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    cur.count += 1;
    loginFailures.set(ip, cur);
    console.warn(`[api] intento de login fallido desde ${ip} (${cur.count}/${LOGIN_MAX_FAILURES})`);
    await new Promise((r) => setTimeout(r, 400)); // frena la fuerza bruta también dentro del cupo
    return res.status(401).json({ error: "Invalid token" });
  }

  loginFailures.delete(ip);
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(candidate)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`
  );
  res.json({ success: true });
});

api.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ success: true });
});

api.get("/auth/status", (req, res) => {
  const state = requestAuthState(req);
  res.json({ enabled: Boolean(authToken), required: state.required, authenticated: state.authenticated });
});

// La versión instalada: apps/desktop/package.json es la fuente única (la que
// sube el tag y la que usa electron-updater). Se lee una vez: no cambia
// mientras el proceso vive; un git pull implica reiniciar.
//
// El supervisor (escritorio y headless) nos la pasa por HYDRA_APP_VERSION, que
// es la fuente fiable: en el backend empaquetado no existe apps/desktop/
// package.json y su lectura daría null. La lectura del archivo queda de reserva
// para `pnpm dev`, donde appRoot es la raíz del repositorio.
const APP_VERSION = (() => {
  const fromEnv = process.env.HYDRA_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return JSON.parse(readFileSync(path.join(appRoot, "apps", "desktop", "package.json"), "utf-8")).version ?? null;
  } catch { return null; }
})();

function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Última release de GitHub vs la instalada, para avisar en el modo navegador
// (el escritorio ya usa electron-updater). Cacheado 6 h: la API de GitHub sin
// token limita a 60 peticiones/hora por IP.
let versionCache: { at: number; latest: string | null; url: string | null } | null = null;
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;

api.get("/version", async (_req, res) => {
  const now = Date.now();
  if (!versionCache || now - versionCache.at > VERSION_TTL_MS) {
    try {
      const r = await fetch("https://api.github.com/repos/TraX22/HydraOps/releases/latest", {
        headers: { "User-Agent": "HydraOps", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      const j = r.ok ? await r.json() as any : null;
      const tag = j && typeof j.tag_name === "string" ? j.tag_name.replace(/^v/, "") : null;
      versionCache = { at: now, latest: tag, url: j?.html_url ?? null };
    } catch {
      // Sin red o sin releases todavía: no es un error, solo no hay dato.
      versionCache = { at: now, latest: null, url: null };
    }
  }
  const latest = versionCache.latest;
  const updateAvailable = Boolean(APP_VERSION && latest && cmpSemver(latest, APP_VERSION) > 0);
  res.json({ current: APP_VERSION, latest, updateAvailable, url: versionCache.url });
});

// --- Worker Management Endpoints ---

const NON_SERVICE_APPS = new Set(["desktop"]);

// En una instalación empaquetada no hay árbol apps/, así que la lista de
// servicios no se puede descubrir del disco: esta es la de referencia.
const KNOWN_SERVICES = [
  "api",
  "key-proxy",
  "orchestrator",
  "outbox-worker",
  "worker-coder",
  "worker-general",
  "worker-graphic",
  "worker-video",
];

async function listServiceNames(): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const d of await readdir(appsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      // Skip leftover empty dirs (no package.json = not a runnable service)
      if (!(await fileExists(path.join(appsDir, d.name, "package.json")))) continue;
      // The desktop shell launches these services; it isn't one of them
      if (NON_SERVICE_APPS.has(d.name)) continue;
      names.push(d.name);
    }
  } catch { /* sin árbol de repositorio: caemos a la lista fija */ }
  return names.length ? names : KNOWN_SERVICES;
}

api.get("/workers", async (req, res) => {
  try {
    const names = await listServiceNames();
    const statuses = await (db as any).select().from(workerStatus);
    const HEARTBEAT_TIMEOUT_MS = 45_000; // services heartbeat every 20s

    const workers = [];
    for (const name of names) {
      const d = { name };

      let status = "offline";
      if (d.name === "api") {
        status = "online"; // this very process is answering the request
      } else if (d.name === "key-proxy") {
        // No DB access by design — probe its /health endpoint instead
        try {
          const proxyBase = (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").replace(/\/$/, "");
          const r = await fetch(`${proxyBase}/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) status = "online";
        } catch { /* offline */ }
      } else {
        const row = statuses.find((s: any) => s.workerId === d.name);
        if (row?.lastHeartbeat) {
          const last = new Date(row.lastHeartbeat).getTime();
          if (Date.now() - last < HEARTBEAT_TIMEOUT_MS) status = "online";
        }
      }

      workers.push({
        id: d.name,
        name: d.name,
        status,
        type: d.name.startsWith("worker-") ? "agent" : "system",
      });
    }
    res.json(workers);
  } catch (err) {
    console.error("[api] GET /workers failed", err);
    res.status(500).json({ error: "Failed to list workers" });
  }
});

api.get("/workers/:id/logs", async (req, res) => {
  try {
    const id = req.params.id.replace(/[^a-z0-9-_]/gi, "");
    const logPath = path.join(logsDir, `${id}.log`);
    if (!(await fileExists(logPath))) {
      return res.type("text/plain").send("");
    }
    const content = await readFile(logPath, "utf-8");
    // Last 300 lines only — the files grow indefinitely
    const lines = content.split(/\r?\n/);
    res.type("text/plain").send(lines.slice(-300).join("\n"));
  } catch (err) {
    console.error("[api] GET /workers/:id/logs failed", err);
    res.status(500).type("text/plain").send("Error reading logs");
  }
});

api.post("/workers", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Worker name is required" });
  
  const workerId = name.toLowerCase().replace(/\s+/g, "-");
  const workerPath = path.join(appsDir, workerId);
  
  if (await fileExists(workerPath)) {
    return res.status(400).json({ error: "Worker already exists" });
  }

  try {
    await mkdir(workerPath, { recursive: true });
    await mkdir(path.join(workerPath, "src"), { recursive: true });
    
    // Create basic worker files (scaffold)
    const pkg = {
      name: `@hydraops/${workerId}`,
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "tsx watch src/index.ts",
        build: "tsup src/index.ts --format esm --out-dir dist",
        start: "node dist/index.js"
      },
      dependencies: {
        "@hydraops/llm": "workspace:*",
        "@hydraops/config": "workspace:*",
        "@hydraops/db": "workspace:*",
        "nats": "^2.29.0",
        "dotenv": "^16.4.5"
      }
    };
    
    const indexTs = `import { config } from "dotenv";
import { loadEnv, envFile } from "@hydraops/config";

config({ path: envFile });

const env = loadEnv({ ...process.env, SERVICE_NAME: "${workerId}" });
console.log(\`[$\{env.SERVICE_NAME\}] Worker started...\`);

// Worker logic for $\{workerId\} goes here
`;

    await writeFile(path.join(workerPath, "package.json"), JSON.stringify(pkg, null, 2));
    await writeFile(path.join(workerPath, "src", "index.ts"), indexTs);
    
    res.status(201).json({ id: workerId, name: workerId, status: 'offline' });
  } catch (err) {
    console.error("[api] POST /workers failed", err);
    res.status(500).json({ error: "Failed to create worker scaffold" });
  }
});

// --- Existing Code ---

/**
 * Une segmentos a baseDir y devuelve la ruta absoluta SOLO si queda dentro de
 * baseDir; si el resultado se sale (por "../", "%2f" decodificado, etc.),
 * devuelve null. Cierra el path traversal en TODA ruta que arma un path con
 * parámetros del request (:id, :filename). path.resolve normaliza los ".." y
 * la comprobación de prefijo garantiza la contención.
 */
function safeJoin(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

// La forma de un id de agente válido (la misma que produce POST /agents al
// sanear el nombre): rechaza separadores, "..", puntos y demás antes de que
// un id llegue a componer una ruta de archivo.
const AGENT_ID_RE = /^[a-z0-9_-]+$/;

// Serve agent directories statically to access avatars
app.use("/avatars", express.static(agentsDir));
app.use("/storage", express.static(storageDir));
app.use("/img", express.static(imgDir));
app.use("/users", express.static(usersDir));
// El manual va en el router api (=> /api/docs): "/docs" a secas chocaría con la
// ruta de Angular, y bajo /api queda tras el token cuando la API está en red.
api.use("/docs", express.static(docsDir));

// Multer storage for avatars - saving as agents/:id/avatar.png
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const { id } = req.params;
    const dest = safeJoin(agentsDir, id);
    if (!dest) return cb(new Error("Invalid agent id"), "");
    try {
      await mkdir(dest, { recursive: true });
      cb(null, dest);
    } catch (err) {
      cb(err as Error, dest);
    }
  },
  filename: (req, file, cb) => {
    cb(null, "avatar.png");
  }
});
const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only PNG, JPG, and WebP are allowed."));
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit
  }
});

// Chat attachments → storage/uploads/<timestamp>-<name> (served via /storage)
const chatUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(uploadsDir, { recursive: true });
        cb(null, uploadsDir);
      } catch (err) {
        cb(err as Error, uploadsDir);
      }
    },
    filename: (_req, file, cb) => {
      const safe = Buffer.from(file.originalname, "latin1").toString("utf8")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

api.post("/upload", (req, res) => {
  chatUpload.single("file")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    let name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    let filename = req.file.filename;
    let mime = req.file.mimetype || "application/octet-stream";

    // llama-server's image decoder (stb) silently drops webp/avif — convert to
    // PNG on upload so the local model can see them too. API models don't care.
    if (mime === "image/webp" || mime === "image/avif" || /\.(webp|avif)$/i.test(name)) {
      try {
        const { default: sharp } = await import("sharp");
        const pngFilename = filename.replace(/\.[^.]*$/, "") + ".png";
        const original = path.join(uploadsDir, filename);
        await sharp(original).png().toFile(path.join(uploadsDir, pngFilename));
        filename = pngFilename;
        name = name.replace(/\.[^.]*$/, "") + ".png";
        mime = "image/png";
        // Best-effort: sharp may still hold the input handle on Windows (EBUSY);
        // a leftover original is harmless, so never fail the conversion for it.
        setTimeout(() => { rm(original, { force: true }).catch(() => { /* ignore */ }); }, 2000);
      } catch (convErr: any) {
        console.error("[api] webp→png conversion failed, keeping original", convErr?.message);
      }
    }

    res.json({
      success: true,
      name,
      mime,
      // Repo-relative path — the workers resolve it against the project root
      path: `storage/uploads/${filename}`,
      // URL for the chat UI (thumbnails / open in browser)
      url: `/storage/uploads/${filename}`,
    });
  });
});

// Same rules for the user's profile photo → users/avatar.png
const userAvatarUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(usersDir, { recursive: true });
        cb(null, usersDir);
      } catch (err) {
        cb(err as Error, usersDir);
      }
    },
    filename: (_req, _file, cb) => cb(null, "avatar.png"),
  }),
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Invalid file type. Only PNG, JPG, and WebP are allowed."));
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

/**
 * Extracts the model from the agent file content.
 * Looks for pattern: - **LLM**: model-name
 */
function extractModel(content: string): string {
  const match = content.match(/- \*\*LLM\*\*:\s*([^\n\r]+)/i);
  return match ? match[1].trim() : "";
}

/**
 * Updates the model in the agent file content.
 */
function updateModelInContent(content: string, model: string): string {
  const regex = /- \*\*LLM\*\*:\s*[^\n\r]*/i;
  const newLine = `- **LLM**: ${model}`;
  if (regex.test(content)) {
    return content.replace(regex, newLine);
  } else {
    // If not found, add to the top section or after a header
    if (content.includes('## Model')) {
      return content.replace('## Model', `## Model\n${newLine}`);
    }
    return content + `\n\n## Model\n${newLine}`;
  }
}

// --- Agent Management Endpoints ---

api.get("/agents", async (req, res) => {
  try {
    const dirs = await readdir(agentsDir, { withFileTypes: true });
    
    // Pre-fetch all DB data once for efficiency
    const configs = await (db as any).select().from(agentConfigs);
    const HEARTBEAT_TIMEOUT_MS = 45_000; // 45s — si no hay heartbeat reciente, está offline

    const agentPromises = dirs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const id = d.name;
        const avatarFileName = "avatar.png";
        const avatarPath = path.join(agentsDir, id, avatarFileName);
        const agentFilePath = path.join(agentsDir, id, `${id}.agent.md`);
        
        const hasAvatar = await fileExists(avatarPath);
        let currentModel = "";
        
        if (await fileExists(agentFilePath)) {
          const content = await readFile(agentFilePath, "utf-8");
          currentModel = extractModel(content);
        }

        // --- STATUS DINÁMICO ---
        const dbConfig = configs.find((c: any) => c.agentId === id);
        let status = "idle"; // Sin color — no configurado

        if (dbConfig) {
          // 1. Verificar heartbeat (¿está vivo el worker?)
          const lastHB = dbConfig.lastHeartbeat ? new Date(dbConfig.lastHeartbeat).getTime() : 0;
          const isAlive = lastHB > 0 && (Date.now() - lastHB) < HEARTBEAT_TIMEOUT_MS;

          if (!isAlive) {
            status = "offline"; // Rojo — worker caído
          } else {
            // 2. Verificar si está procesando una tarea ahora mismo
            const activeTasks = await (db as any).select().from(tasks)
              .where(and(eq(tasks.assignedAgent, id), eq(tasks.status, "assigned")))
              .limit(1);

            if (activeTasks.length > 0) {
              status = "working"; // Azul — procesando
            } else {
              // 3. Verificar si tiene mensajes sin leer
              const unreadTasks = await (db as any).select().from(tasks)
                .where(and(
                  eq(tasks.assignedAgent, id),
                  eq(tasks.status, "completed"),
                  eq(tasks.isRead, false)
                ))
                .limit(1);

              if (unreadTasks.length > 0) {
                status = "online"; // Verde — completó algo que el usuario no leyó
              } else {
                status = "idle"; // Sin color — activo pero sin mensajes pendientes
              }
            }
          }
        }
        
        return {
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          emoji: hasAvatar ? null : "🤖",
          avatarUrl: hasAvatar ? `/avatars/${id}/${avatarFileName}?v=${Date.now()}` : null,
          role: "HydraOps Agent",
          status,
          gradient: "linear-gradient(135deg, #1e5cbf, #3b82f6)",
          tags: ["managed"],
          llmModel: currentModel 
        };
      });
      
    const agents = await Promise.all(agentPromises);
    
    // Enrich with database configs if they exist
    const agentsWithDbConfig = agents.map(agent => {
      const dbConfig = configs.find((c: any) => c.agentId === agent.id);
      if (dbConfig) {
        return { 
          ...agent, 
          llmModel: dbConfig.model,
          workerType: dbConfig.workerType,
          graphicEngine: dbConfig.graphicEngine,
          graphicFormat: dbConfig.graphicFormat
        };
      }
      return agent;
    });

    res.json(agentsWithDbConfig);
  } catch (err) {
    console.error("[api] GET /agents failed", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

api.get("/agents/:id/files", async (req, res) => {
  const { id } = req.params;
  const agentPath = safeJoin(agentsDir, id);
  if (!agentPath) return res.status(404).json({ error: "Agent not found" });
  try {
    const files = await readdir(agentPath);
    // Filter to only include .md or .yaml files mapping to the known types
    const validFiles = files.filter(f => f.includes('.md') || f.includes('.yaml'));
    res.json(validFiles);
  } catch (err) {
    res.status(404).json({ error: "Agent not found" });
  }
});

api.get("/agents/:id/files/:filename", async (req, res) => {
  const { id, filename } = req.params;
  const filePath = safeJoin(agentsDir, id, filename);
  if (!filePath) return res.status(404).json({ error: "File not found" });
  try {
    const content = await readFile(filePath, "utf-8");
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: "File not found" });
  }
});

api.put("/agents/:id/files/:filename", async (req, res) => {
  const { id, filename } = req.params;
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: "content is required" });

  const filePath = safeJoin(agentsDir, id, filename);
  if (!filePath) return res.status(400).json({ error: "Invalid path" });
  try {
    await writeFile(filePath, content, "utf-8");
    res.json({ success: true });
  } catch (err) {
    console.error(`[api] PUT /agents/${id}/files/${filename} failed`, err);
    res.status(500).json({ error: "Failed to save file" });
  }
});

api.post("/agents", async (req, res) => {
  const { name, role, emoji, workerType, model } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  // "Ana María" → "ana_maria"; strip accents and anything outside [a-z0-9_-]
  const id = String(name).trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "");
  if (!id) return res.status(400).json({ error: "name has no valid characters" });
  const agentPath = path.join(agentsDir, id);

  try {
    // Never overwrite an existing agent's personality files
    const dirs = await readdir(agentsDir);
    if (dirs.includes(id)) {
      return res.status(409).json({ error: `Agent "${id}" already exists` });
    }

    await mkdir(agentPath, { recursive: true });

    // Create base files with smarter templates
    const baseFiles = ["soul", "skill", "agent", "heartbeat", "memory", "tools"];
    for (const type of baseFiles) {
      const fileName = `${id}.${type}.md`;
      const template = `# ${name} — ${type.toUpperCase()}\n\nEste es el archivo ${type} del agente ${name}.\nConfiguración inicial generada por HydraOps UI.`;
      await writeFile(path.join(agentPath, fileName), template, "utf-8");
    }

    // Register in DB so the agent gets a workerType/model and worker heartbeats
    const finalModel = model || process.env.DEFAULT_MODEL || "gemini-2.5-flash-lite";
    const finalWorker = workerType || "general";
    await (db as any).insert(agentConfigs)
      .values({ agentId: id, model: finalModel, workerType: finalWorker, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: agentConfigs.agentId,
        set: { model: finalModel, workerType: finalWorker, updatedAt: new Date() },
      })
      .run();

    res.status(201).json({ id, name, workerType: finalWorker, model: finalModel, role: role || "HydraOps Agent", emoji: emoji || "🤖" });
  } catch (err) {
    console.error("[api] POST /agents failed", err);
    res.status(500).json({ error: "Failed to create agent directory" });
  }
});

api.delete("/agents/:id", async (req, res) => {
  const { id } = req.params;
  const agentPath = path.join(agentsDir, id);
  
  try {
    // Check if directory exists
    const dirs = await readdir(agentsDir);
    if (!dirs.includes(id)) {
      return res.status(404).json({ error: "Agent not found" });
    }
    
    // Delete recursively
    await rm(agentPath, { recursive: true, force: true });
    // Drop its config row too, or workers keep heartbeating a ghost agent
    await (db as any).delete(agentConfigs).where(eq(agentConfigs.agentId, id)).run();
    res.json({ success: true, message: `Agent ${id} deleted successfully` });
  } catch (err) {
    console.error(`[api] DELETE /agents/${id} failed`, err);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

/**
 * Rename an agent: folder, personality files, DB references (config, tasks, crons).
 */
api.patch("/agents/:id/rename", async (req, res) => {
  const oldId = req.params.id;
  const newId = String(req.body?.newId ?? "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  if (!newId) return res.status(400).json({ error: "newId is required (letters, digits, - and _ only)" });
  if (newId === oldId) return res.json({ success: true, id: newId });

  try {
    const dirs = await readdir(agentsDir);
    if (!dirs.includes(oldId)) return res.status(404).json({ error: "Agent not found" });
    if (dirs.includes(newId)) return res.status(409).json({ error: `An agent named "${newId}" already exists` });

    // 1. Rename the folder
    await rename(path.join(agentsDir, oldId), path.join(agentsDir, newId));

    // 2. Rename the personality files inside (<old>.<type>.md → <new>.<type>.md)
    const files = await readdir(path.join(agentsDir, newId));
    for (const f of files) {
      if (f.startsWith(`${oldId}.`) && f.endsWith(".md")) {
        const suffix = f.slice(oldId.length); // ".soul.md" etc.
        await rename(path.join(agentsDir, newId, f), path.join(agentsDir, newId, `${newId}${suffix}`));
      }
    }

    // 3. Update DB references
    await (db as any).update(agentConfigs).set({ agentId: newId, updatedAt: new Date() }).where(eq(agentConfigs.agentId, oldId)).run();
    await (db as any).update(tasks).set({ assignedAgent: newId }).where(eq(tasks.assignedAgent, oldId)).run();
    await (db as any).update(tasks).set({ channel: newId }).where(eq(tasks.channel, oldId)).run();
    await (db as any).update(cronJobs).set({ assignedAgent: newId, updatedAt: new Date() }).where(eq(cronJobs.assignedAgent, oldId)).run();

    console.log(`[api] Agent renamed: ${oldId} → ${newId}`);
    res.json({ success: true, id: newId });
  } catch (err: any) {
    console.error(`[api] PATCH /agents/${oldId}/rename failed`, err);
    res.status(500).json({ error: "Failed to rename agent", detail: err?.message });
  }
});

/**
 * Endpoint for uploading agent avatar
 */
api.post("/agents/:id/avatar", (req, res, next) => {
  const uploadSingle = upload.single("avatar");
  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded or invalid format (PNG/JPG/WebP only)" });
    }
    res.json({ 
      success: true, 
      avatarUrl: `/avatars/${id}/avatar.png?v=${Date.now()}` 
    });
  });
});

// --- Config Endpoints ---

api.get("/agents/:id/config", async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: "Invalid agent id" });
  try {
    const rows = await (db as any).select().from(agentConfigs).where(eq(agentConfigs.agentId, id)).limit(1);
    if (rows.length > 0) {
      return res.json(rows[0]);
    }
    
    // Fallback: extract from file if not in DB
    const agentFilePath = path.join(agentsDir, id, `${id}.agent.md`);
    if (await fileExists(agentFilePath)) {
      const content = await readFile(agentFilePath, "utf-8");
      const model = extractModel(content);
      return res.json({ agentId: id, model });
    }

    res.json({ agentId: id, model: "" });
  } catch (err) {
    console.error(`[api] GET /agents/${id}/config failed`, err);
    res.status(500).json({ error: "Failed to fetch agent config" });
  }
});

api.post("/agents/:id/config", async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: "Invalid agent id" });
  const { model, workerType, graphicEngine, graphicFormat, resolution } = req.body;
  if (!model) return res.status(400).json({ error: "model is required" });

  try {
    // 1. Update/Insert in database
    const finalModel = model || process.env.DEFAULT_MODEL || 'gemini-2.5-flash-lite';
    const updatePayload: any = { model: finalModel, updatedAt: new Date() };
    if (workerType) updatePayload.workerType = workerType;
    if (graphicEngine) updatePayload.graphicEngine = graphicEngine;
    if (graphicFormat) updatePayload.graphicFormat = graphicFormat;
    if (resolution) updatePayload.resolution = resolution;

    await (db as any).insert(agentConfigs)
      .values({ agentId: id, ...updatePayload })
      .onConflictDoUpdate({
        target: agentConfigs.agentId,
        set: updatePayload
      })
      .run();

    // 2. Update in {id}.agent.md file (optional)
    const agentFilePath = path.join(agentsDir, id, `${id}.agent.md`);
    if (await fileExists(agentFilePath)) {
      const content = await readFile(agentFilePath, "utf-8");
      const updatedContent = updateModelInContent(content, model);
      await writeFile(agentFilePath, updatedContent, "utf-8");
    }

    res.json({ success: true, model: finalModel, ...updatePayload });
  } catch (err) {
    console.error(`[api] POST /agents/${id}/config failed`, err);
    res.status(500).json({ error: "Failed to update agent config" });
  }
});

// Helper for Cron system NATS propagation
function notifyCronUpdate(tx: any) {
  const eventId = randomUUID();
  const ev = buildEnvelope({
      id: eventId,
      type: "system.cron_updated",
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: env.SERVICE_NAME,
      subject: { entity: "system", id: "cron" },
      data: {}
  });
  tx.insert(eventsTable).values({
      id: eventId,
      type: ev.type,
      version: ev.version,
      occurredAt: new Date(ev.occurredAt),
      producer: ev.producer,
      subjectEntity: ev.subject.entity,
      subjectId: ev.subject.id,
      payload: ev
  }).run();
  tx.insert(outboxTable).values({ eventId, status: "pending" }).run();
}

// --- Cron Endpoints ---
api.get("/crons", async (req, res) => {
  try {
    const records = await (db as any).select().from(cronJobs).orderBy(asc(cronJobs.createdAt));
    res.json(records);
  } catch (err) {
    console.error("[api] GET /crons failed", err);
    res.status(500).json({ error: "Failed to fetch crons" });
  }
});

api.post("/crons", async (req, res) => {
  try {
    const { id, name, prompt, cronExpression } = req.body;
    const assignedAgent = req.body.assignedAgent ?? null;
    const status = req.body.status ?? "active";
    const cronId = id || randomUUID();

    await (db as any).transaction((tx: any) => {
      tx.insert(cronJobs).values({
        id: cronId,
        name: name || "Unnamed task",
        prompt,
        cronExpression,
        assignedAgent: assignedAgent || null,
        status,
        updatedAt: new Date(),
        createdAt: new Date(),
      }).onConflictDoUpdate({
        target: cronJobs.id,
        set: {
          name: name || "Unnamed task",
          prompt,
          cronExpression,
          assignedAgent: assignedAgent || null,
          status,
          updatedAt: new Date(),
        }
      }).run();
      notifyCronUpdate(tx);
    });
    
    res.json({ success: true, id: cronId });
  } catch (err) {
    console.error("[api] POST /crons failed", err);
    res.status(500).json({ error: "Failed to save task" });
  }
});

api.delete("/crons/:id", async (req, res) => {
  try {
    await (db as any).transaction((tx: any) => {
      tx.delete(cronJobs).where(eq(cronJobs.id, req.params.id)).run();
      notifyCronUpdate(tx);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[api] DELETE /crons failed", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

api.put("/crons/:id", async (req, res) => {
  const { id } = req.params;
  const { name, prompt, cronExpression } = req.body;
  const assignedAgent = req.body.assignedAgent;
  const status = req.body.status;
  try {
    (db as any).transaction((tx: any) => {
      tx.update(cronJobs)
        .set({
          name,
          prompt,
          cronExpression,
          assignedAgent,
          status,
          updatedAt: new Date()
        })
        .where(eq(cronJobs.id, id))
        .run();
      notifyCronUpdate(tx);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[api] PUT /crons/:id failed", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

api.patch("/crons/:id/toggle", async (req, res) => {
  try {
    // The status can come in the body; with an empty body the server flips the
    // current value (the UI calls it as a pure toggle).
    const requested = req.body?.status;
    const rows = await (db as any).select().from(cronJobs).where(eq(cronJobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Task not found" });
    const newStatus = requested ?? (rows[0].status === "active" ? "paused" : "active");
    await (db as any).transaction((tx: any) => {
      tx.update(cronJobs).set({ status: newStatus, updatedAt: new Date() }).where(eq(cronJobs.id, req.params.id)).run();
      notifyCronUpdate(tx);
    });
    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error("[api] PATCH /crons toggle failed", err);
    res.status(500).json({ error: "Failed to toggle task" });
  }
});

// --- Config Endpoints ---

const envMapping: Record<string, string> = {
  natsUrl: "NATS_URL",
  openaiKey: "OPENAI_API_KEY",
  anthropicKey: "ANTHROPIC_API_KEY",
  geminiKey: "GEMINI_API_KEY",
  groqKey: "GROQ_API_KEY",
  xaiKey: "XAI_API_KEY",
  leonardoKey: "LEONARDO_API_KEY",
  openrouterKey: "OPENROUTER_API_KEY",
  mistralKey: "MISTRAL_API_KEY",
  deepseekKey: "DEEPSEEK_API_KEY",
  qwenKey: "QWEN_API_KEY",
  kimiKey: "KIMI_API_KEY",
  glmKey: "GLM_API_KEY",
  localLlmUrl: "LOCAL_LLM_URL",
  localLlmKey: "LOCAL_LLM_KEY",
  localLlmModel: "LOCAL_LLM_MODEL",
  defaultModel: "DEFAULT_MODEL",
  logLevel: "LOG_LEVEL"
};

// The local LLM config lives ONLY in .env (single source of truth, one model at
// a time). It is never mirrored to system_configs — a DB copy would shadow the
// file and leave stale model names around when the user swaps local LLMs.
const LOCAL_ENV_KEYS = new Set(["LOCAL_LLM_URL", "LOCAL_LLM_KEY", "LOCAL_LLM_MODEL"]);

// --- Key store (credential firewall) ---
// Real provider API keys live ONLY in the key store (see keyStoreFile in
// @hydraops/config for the per-platform location), read by
// the API (trusted, for model listing) and the key-proxy (which injects them
// at the network boundary). DB/.env hold the literal placeholder "proxy" so
// workers still detect "this provider is configured" without ever seeing the
// key. The store lives outside the project tree on purpose: agent file tools
// scoped to the repo can never reach it.
const PROVIDER_KEY_NAMES = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
  "XAI_API_KEY", "LEONARDO_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY", "QWEN_API_KEY", "KIMI_API_KEY", "GLM_API_KEY",
];
const KEY_PLACEHOLDER = "proxy";
// Masked values round-trip through the UI; POST /config already ignores
// anything containing this dotted placeholder, so a re-saved mask is a no-op.
const KEY_MASK_DOTS = "...............";
const KEY_STORE_PATH = keyStoreFile;

async function loadKeyStore(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(KEY_STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveKeyStore(keys: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(KEY_STORE_PATH), { recursive: true });
  await writeFile(KEY_STORE_PATH, JSON.stringify(keys, null, 2), "utf-8");
}

const isRealKeyValue = (v: string | undefined | null): v is string =>
  !!v && v.trim() !== "" && v.trim() !== KEY_PLACEHOLDER && !v.includes(KEY_MASK_DOTS);

function maskKey(v: string): string {
  return v.length > 12 ? v.slice(0, 4) + KEY_MASK_DOTS + v.slice(-4) : KEY_MASK_DOTS;
}

/**
 * One-time (idempotent) migration: move any real key values out of the DB and
 * the root .env into the key store, leaving the "proxy" placeholder behind.
 */
async function migrateKeysToStore() {
  try {
    const store = await loadKeyStore();
    let storeChanged = false;
    const migrated: string[] = [];

    // 1. DB rows → store
    const rows = await (db as any).select().from(systemConfigs);
    for (const name of PROVIDER_KEY_NAMES) {
      const row = rows.find((r: any) => r.key === name);
      if (row && isRealKeyValue(row.value)) {
        store[name] = row.value.trim();
        storeChanged = true;
        migrated.push(name);
        await (db as any).update(systemConfigs)
          .set({ value: KEY_PLACEHOLDER, updatedAt: new Date() })
          .where(eq(systemConfigs.key, name)).run();
      }
      // Keep the DB "configured" flag in sync with the store
      if (store[name] && !rows.find((r: any) => r.key === name)) {
        await (db as any).insert(systemConfigs)
          .values({ key: name, value: KEY_PLACEHOLDER, updatedAt: new Date() })
          .onConflictDoNothing().run();
      }
    }

    // 2. .env lines → store (workers fall back to process.env when a DB row is missing)
    const envPathPath = envFile;
    try {
      const content = await readFile(envPathPath, "utf-8");
      const lines = content.split(/\r?\n/);
      let envChanged = false;
      const newLines = lines.map(line => {
        if (!line.trim() || line.startsWith("#")) return line;
        const idx = line.indexOf("=");
        if (idx === -1) return line;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (PROVIDER_KEY_NAMES.includes(key) && isRealKeyValue(value)) {
          if (!store[key]) { store[key] = value; storeChanged = true; if (!migrated.includes(key)) migrated.push(key); }
          envChanged = true;
          return `${key}=${KEY_PLACEHOLDER}`;
        }
        return line;
      });
      if (envChanged) await writeFile(envPathPath, newLines.join("\n"), "utf-8");
    } catch { /* no .env */ }

    if (storeChanged) {
      await saveKeyStore(store);
      console.log(`[api] key store: migrated ${migrated.join(", ")} → ${KEY_STORE_PATH}`);
    }
    // Neutralize any real keys inherited by this process's env
    for (const name of PROVIDER_KEY_NAMES) {
      if (isRealKeyValue(process.env[name])) process.env[name] = KEY_PLACEHOLDER;
    }
  } catch (err) {
    console.error("[api] migrateKeysToStore failed", err);
  }
}

// El parseo vive en @hydraops/config: los workers leen lo mismo en cada tarea.
async function readLocalLlmFromEnvFile(): Promise<Record<string, string>> {
  return readLocalLlmEnv();
}

import {
  listAvailableGeminiModels,
  listAvailableGroqModels,
  listAvailableOpenAIModels,
  listAvailableXAIModels,
  listAvailableAnthropicModels,
  listAvailableMistralModels,
  listAvailableOpenRouterModels,
  listAvailableLeonardoModels,
  listAvailableDeepSeekModels,
  listAvailableQwenModels,
  listAvailableKimiModels,
  listAvailableGLMModels,
} from "@hydraops/llm";

api.get("/config/models", async (req, res) => {
  try {
    const allModels: { id: string; name: string; provider: string; type?: string; description?: string; inputTokenLimit?: string; outputTokenLimit?: string; isImage?: boolean; isVideo?: boolean; isCoder?: boolean; emoji?: string }[] = [];
    
    // Classify each model into a capability type. Some providers expose real
    // metadata (Gemini supportedGenerationMethods, OpenRouter modality); for the
    // rest the model name is the only signal, so this is heuristic by design.
    const identify = (modelId: string) => {
      const lower = modelId.toLowerCase();
      let type: 'chat' | 'coder' | 'image' | 'video' | 'audio' | 'embedding' = 'chat';
      let emoji = '🧠';

      if (/veo|sora|video|film|movie|(^|[\/\-_.:])kling|wan2|motion|svd/.test(lower)) {
        type = 'video';
        emoji = '🎬';
      } else if (/imagen|image|dall-e|flux|imagine|stable-diffusion|sdxl|pixart|photon/.test(lower)) {
        type = 'image';
        emoji = '🎨';
      } else if (/whisper|tts|audio|speech|transcribe|voice|sonic/.test(lower)) {
        type = 'audio';
        emoji = '🎧';
      } else if (/embed|embedding|rerank/.test(lower)) {
        type = 'embedding';
        emoji = '📐';
      } else if (/coder|coding|codestral|codellama|codex|devstral|deepseek/.test(lower)) {
        type = 'coder';
        emoji = '👩‍💻';
      }

      return {
        type,
        emoji,
        canGenerateText: type === 'chat' || type === 'coder',
        canGenerateImage: type === 'image',
        canGenerateVideo: type === 'video',
        isImage: type === 'image',
        isVideo: type === 'video',
        isCoder: type === 'coder'
      };
    };

    // Keys can live in system_configs (saved from the UI) or .env — DB wins,
    // matching GET /config and the workers' getGlobalConfig behavior.
    const dbConfigs = await (db as any).select().from(systemConfigs);
    const keyStore = await loadKeyStore();
    const getKey = (envName: string) => {
      // Real keys come from the store; DB/env only hold the "proxy" placeholder
      if ((keyStore[envName] || "").trim()) return keyStore[envName].trim();
      const legacy = (dbConfigs.find((c: any) => c.key === envName)?.value || process.env[envName] || "").trim();
      return isRealKeyValue(legacy) ? legacy : "";
    };

    // Query every configured provider in parallel; each fetcher returns [] on failure
    // so one bad key can't empty the whole dropdown.
    const providerJobs: Promise<void>[] = [];

    // Source-of-access label shown before the provider name so the user can
    // tell at a glance how a model is paid/accessed:
    //   "APIkey · ..." → uses one of the configured API keys (tokens billed)
    //   "Local: ..."   → the local llama-server/LM Studio model
    //   (future) "Log · ..." → models accessed via login, added later
    const viaKey = (label: string) => `APIkey · ${label}`;

    const groqKey = getKey("GROQ_API_KEY");
    if (groqKey) providerJobs.push(listAvailableGroqModels(groqKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`Groq: ${m}`), provider: 'groq', ...identify(m) })));
    }).catch(() => {}));

    const geminiKey = getKey("GEMINI_API_KEY");
    if (geminiKey) providerJobs.push(listAvailableGeminiModels(geminiKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`Gemini: ${m}`), provider: 'google', ...identify(m) })));
    }).catch(() => {}));

    const openaiKey = getKey("OPENAI_API_KEY");
    if (openaiKey) providerJobs.push(listAvailableOpenAIModels(openaiKey).then(models => {
      allModels.push(...models
        .filter(m => m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('dall-e'))
        .map(m => ({ id: m, name: viaKey(`OpenAI: ${m}`), provider: 'openai', ...identify(m) })));
    }).catch(() => {}));

    const xaiKey = getKey("XAI_API_KEY");
    if (xaiKey) providerJobs.push(listAvailableXAIModels(xaiKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`xAI: ${m}`), provider: 'xai', ...identify(m) })));
    }).catch(() => {}));

    const anthropicKey = getKey("ANTHROPIC_API_KEY");
    if (anthropicKey) providerJobs.push(listAvailableAnthropicModels(anthropicKey).then(models => {
      if (models.length === 0) {
        // Discovery endpoint unavailable → sensible fallback
        allModels.push({ id: 'claude-sonnet-4-5', name: viaKey('Anthropic: Claude Sonnet 4.5'), provider: 'anthropic', type: 'chat', emoji: '🧠' });
      } else {
        allModels.push(...models.map(m => ({ id: m, name: viaKey(`Anthropic: ${m}`), provider: 'anthropic', ...identify(m) })));
      }
    }).catch(() => {}));

    const mistralKey = getKey("MISTRAL_API_KEY");
    if (mistralKey) providerJobs.push(listAvailableMistralModels(mistralKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`Mistral: ${m}`), provider: 'mistral', ...identify(m) })));
    }).catch(() => {}));

    const openrouterKey = getKey("OPENROUTER_API_KEY");
    if (openrouterKey) providerJobs.push(listAvailableOpenRouterModels(openrouterKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`OpenRouter: ${m}`), provider: 'openrouter', ...identify(m) })));
    }).catch(() => {}));

    const deepseekKey = getKey("DEEPSEEK_API_KEY");
    if (deepseekKey) providerJobs.push(listAvailableDeepSeekModels(deepseekKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`DeepSeek: ${m}`), provider: 'deepseek', ...identify(m) })));
    }).catch(() => {}));

    const qwenKey = getKey("QWEN_API_KEY");
    if (qwenKey) providerJobs.push(listAvailableQwenModels(qwenKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`Qwen: ${m}`), provider: 'qwen', ...identify(m) })));
    }).catch(() => {}));

    const kimiKey = getKey("KIMI_API_KEY");
    if (kimiKey) providerJobs.push(listAvailableKimiModels(kimiKey).then(models => {
      allModels.push(...models.map(m => ({ id: m, name: viaKey(`Kimi: ${m}`), provider: 'kimi', ...identify(m) })));
    }).catch(() => {}));

    const glmKey = getKey("GLM_API_KEY");
    if (glmKey) providerJobs.push(listAvailableGLMModels(glmKey).then(models => {
      // The flat Coding Plan endpoint may not expose /models (and an sk-sp- key
      // can't query the general endpoint), so merge whatever discovery returns
      // with a static fallback of the current GLM coding models.
      const fallback = ['glm-4.6', 'glm-4.7', 'glm-5.1'];
      const ids = Array.from(new Set([...(models ?? []), ...fallback]));
      allModels.push(...ids.map(m => ({ id: m, name: viaKey(`GLM: ${m}`), provider: 'glm', ...identify(m) })));
    }).catch(() => {}));

    const leonardoKey = getKey("LEONARDO_API_KEY");
    if (leonardoKey) providerJobs.push(listAvailableLeonardoModels(leonardoKey).then(models => {
      // Leonardo is image/video generation. The generic 'leonardo-ai' entry is
      // both: default image engine AND the Motion 2.0 video engine.
      allModels.push({ id: 'leonardo-ai', name: viaKey('Leonardo: Signature (default)'), provider: 'leonardo', type: 'video', isImage: true, isVideo: true, emoji: '🎬' });
      allModels.push(...models.map(m => ({ id: m.id, name: viaKey(`Leonardo: ${m.name}`), provider: 'leonardo', type: 'image', isImage: true, emoji: '🎨' })));
    }).catch(() => {}));

    await Promise.all(providerJobs);

    // Local LLM si está configurado — leído SIEMPRE del .env. El id es estable
    // ('local-model'): al cambiar de modelo local solo cambia la etiqueta, así
    // defaultModel y los agentes que lo referencian nunca quedan huérfanos.
    const localEnv = await readLocalLlmFromEnvFile();
    const localLlmUrl = (localEnv.LOCAL_LLM_URL || "").trim();
    const localLlmModel = (localEnv.LOCAL_LLM_MODEL || "").trim();
    if (localLlmUrl) {
      allModels.push({
        id: 'local-model',
        name: `Local: ${localLlmModel || 'LM Studio'}`,
        provider: 'local',
        type: 'chat',
        emoji: '🧠'
      });
    }

    res.json(allModels);
  } catch (err) {
    console.error("[api] GET /config/models failed", err);
    res.status(500).json({ error: "Failed to fetch models" });
  }
});

api.get("/config", async (req, res) => {
  try {
    const envPathPath = envFile;
    let content = "";
    try {
      content = await readFile(envPathPath, "utf-8");
    } catch (e) { }

    const config: Record<string, string> = {
      natsUrl: "nats://127.0.0.1:4222",
      openaiKey: "",
      anthropicKey: "",
      geminiKey: "",
      groqKey: "",
      xaiKey: "",
      leonardoKey: "",
      openrouterKey: "",
      mistralKey: "",
      localLlmUrl: "",
      localLlmKey: "",
      localLlmModel: "",
      defaultModel: "",
      logLevel: "info"
    };

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() && !line.startsWith('#')) {
        const parts = line.split('=');
        const envKey = parts[0].trim();
        const envValue = parts.slice(1).join('=').trim();
        
        // Find which config key matches this envKey
        for (const [key, mappedEnv] of Object.entries(envMapping)) {
          if (mappedEnv === envKey) {
            config[key] = envValue;
          }
        }
      }
    }
    
    // Merge with DB values (overriding .env) — except the local LLM keys,
    // whose single source of truth is the .env file.
    const dbConfigs = await (db as any).select().from(systemConfigs);
    for (const dbCfg of dbConfigs) {
      if (LOCAL_ENV_KEYS.has(dbCfg.key)) continue;
      // Find which config key matches this envKey (dbCfg.key is the ENV key)
      for (const [key, mappedEnv] of Object.entries(envMapping)) {
        if (mappedEnv === dbCfg.key) {
          config[key] = dbCfg.value;
        }
      }
    }
    
    // Provider keys: never return real values (nor the "proxy" placeholder) —
    // show a stable mask the UI can round-trip without overwriting anything.
    const keyStore = await loadKeyStore();
    for (const [cfgKey, envName] of Object.entries(envMapping)) {
      if (!PROVIDER_KEY_NAMES.includes(envName)) continue;
      const real = (keyStore[envName] || "").trim();
      config[cfgKey] = real ? maskKey(real) : "";
    }

    res.json(config);
  } catch (err) {
    console.error("[api] GET /config failed", err);
    res.status(500).json({ error: "Failed to read config" });
  }
});

/**
 * Migration helper: Sync .env to DB if DB is empty
 */
async function syncConfigToDb() {
  try {
    const dbConfigs = await (db as any).select().from(systemConfigs);
    if (dbConfigs.length > 0) return; // Already migrated
    
    console.log("[api] Migrating .env config to database...");
    const envPathPath = envFile;
    let content = "";
    try {
      content = await readFile(envPathPath, "utf-8");
    } catch (e) { return; }

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() && !line.startsWith('#')) {
        const parts = line.split('=');
        const envKey = parts[0].trim();
        const envValue = parts.slice(1).join('=').trim();
        
        // Only sync known keys (local LLM keys stay in .env only)
        if (Object.values(envMapping).includes(envKey) && envValue && !LOCAL_ENV_KEYS.has(envKey)) {
          await (db as any).insert(systemConfigs).values({
            key: envKey,
            value: envValue,
            updatedAt: new Date()
          }).onConflictDoNothing().run();
        }
      }
    }
  } catch (err) {
    console.error("[api] syncConfigToDb failed", err);
  }
}

// Perform sync on startup, then pull real keys out of DB/.env into the key store
syncConfigToDb().then(() => migrateKeysToStore());

api.post("/config", async (req, res) => {
  try {
    const updates = req.body;
    const envDocs: Record<string, string> = {};

    // Map JSON payload to ENV keys
    for (const [key, value] of Object.entries(updates)) {
      const envKey = envMapping[key];
      if (envKey && typeof value === "string") {
        envDocs[envKey] = value;
      }
    }

    // Provider keys: real values go ONLY to the key store; DB/.env get the
    // "proxy" placeholder. Masked round-trips are dropped (nothing changed).
    {
      const store = await loadKeyStore();
      let storeChanged = false;
      for (const envKey of PROVIDER_KEY_NAMES) {
        if (!(envKey in envDocs)) continue;
        const value = envDocs[envKey];
        if (value.includes(KEY_MASK_DOTS) || value.trim() === KEY_PLACEHOLDER) {
          delete envDocs[envKey]; // unchanged mask → keep everything as is
        } else if (value.trim() === "") {
          if (store[envKey]) { delete store[envKey]; storeChanged = true; }
          // empty string flows through → clears DB/.env, provider shows as unconfigured
        } else {
          store[envKey] = value.trim();
          storeChanged = true;
          envDocs[envKey] = KEY_PLACEHOLDER;
        }
      }
      if (storeChanged) await saveKeyStore(store);
    }

    const envPathPath = envFile;
    let content = "";
    try {
      content = await readFile(envPathPath, "utf-8");
    } catch (e) { }

    const lines = content.split(/\r?\n/);
    const newLines: string[] = [];
    const updatedKeys = new Set<string>();

    for (const line of lines) {
      if (line.trim() && !line.startsWith('#')) {
        const parts = line.split('=');
        const key = parts[0].trim();
        const oldLine = line;
        const newValue = envDocs[key];
        
        // Solo ignoramos si es un placeholder (puntos), permitimos vacíos para limpiar
        if (newValue !== undefined && !newValue.includes("...............")) {
          newLines.push(`${key}=${newValue}`);
        } else {
          // Mantenemos lo que ya estaba
          newLines.push(oldLine);
        }
        updatedKeys.add(key);
      } else {
        newLines.push(line);
      }
    }

    for (const [key, value] of Object.entries(envDocs)) {
      if (!updatedKeys.has(key) && !value.includes("...............")) {
        newLines.push(`${key}=${value}`);
      }
    }

    await writeFile(envPathPath, newLines.join('\n'), "utf-8");
    
    // 2. Also update in database for dynamic access by workers — EXCEPT the
    // local LLM keys, which live only in .env (one model at a time).
    for (const [key, value] of Object.entries(envDocs)) {
      if (LOCAL_ENV_KEYS.has(key)) continue;
      if (value !== undefined && !value.includes("...............")) {
        await (db as any).insert(systemConfigs).values({
          key,
          value,
          updatedAt: new Date()
        }).onConflictDoUpdate({
          target: systemConfigs.key,
          set: { value, updatedAt: new Date() }
        }).run();
      }
    }

    // Drop any legacy DB copies of the local LLM keys so they can't shadow .env
    for (const key of LOCAL_ENV_KEYS) {
      await (db as any).delete(systemConfigs).where(eq(systemConfigs.key, key)).run();
    }

    // Reload into node process as well just in case
    for (const [k, v] of Object.entries(envDocs)) {
      process.env[k] = v;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[api] POST /config failed", err);
    res.status(500).json({ error: "Failed to write config" });
  }
});

// --- Task endpoints ---

api.post("/tasks", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? "");
    let userId = String(req.body?.userId ?? "").trim();
    if (!userId || userId === "undefined") userId = "system-admin";
    const priority = String(req.body?.priority ?? "normal").toLowerCase() as any;

    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    const channel = String(req.body?.channel ?? "main");

    const taskId = randomUUID();
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    const envelope = buildEnvelope({
      id: eventId,
      type: "task.created",
      version: 1,
      occurredAt,
      producer: env.SERVICE_NAME,
      subject: { entity: "task", id: taskId },
      data: {
        taskId,
        prompt,
        userId,
        channel,
        priority,
        date: occurredAt,
      },
    });

    await (db as any).transaction((tx: any) => {
      tx.insert(tasks).values({
        id: taskId,
        prompt,
        channel,
        status: "pending",
        isRead: true, // user's own message starts read
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();

      tx.insert(eventsTable).values({
        id: eventId,
        type: envelope.type,
        version: envelope.version,
        occurredAt: new Date(envelope.occurredAt),
        producer: envelope.producer,
        subjectEntity: envelope.subject.entity,
        subjectId: envelope.subject.id,
        payload: envelope,
      }).run();

      tx.insert(outboxTable).values({
        eventId,
        status: "pending",
        nextAttemptAt: new Date(),
      }).run();
    });

    res.status(201).json({ id: taskId, taskId, status: "pending" });
  } catch (err: any) {
    console.error("[api] POST /tasks failed:", err?.message ?? err);
    res.status(500).json({ error: "internal_error", detail: err?.message });
  }
});

// Chat-message shaped history for the Angular UI: one user bubble per task,
// plus an assistant bubble (typing placeholder until the task completes).
api.get("/tasks", async (req, res) => {
  try {
    const channel = String(req.query.channel ?? "main");
    const hours24 = 24 * 60 * 60 * 1000;
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - hours24);

    const rows = await (db as any).select().from(tasks)
      .where(and(eq(tasks.channel, channel), gte(tasks.createdAt, since)))
      .orderBy(asc(tasks.createdAt));

    const messages: any[] = [];
    for (const row of rows) {
      const created = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
      messages.push({
        id: `${row.id}-u`,
        role: "user",
        content: row.prompt,
        timestamp: created,
        taskId: row.id,
      });

      const agentId = row.assignedAgent ?? null;
      const agentName = agentId ? agentId.charAt(0).toUpperCase() + agentId.slice(1) : "Agent";
      const hasAvatar = agentId ? await fileExists(path.join(agentsDir, agentId, "avatar.png")) : false;
      if (row.status === "completed" || row.status === "failed") {
        const meta = row.resultMeta ?? {};
        const updated = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString();
        messages.push({
          id: `${row.id}-a`,
          role: "assistant",
          content: meta.text || meta.preview || meta.raw || (meta.error ? `⚠️ ${meta.error}` : (row.status === "failed" ? "⚠️ Task failed." : "")),
          agentId,
          agentName,
          avatarUrl: hasAvatar ? `/avatars/${agentId}/avatar.png` : null,
          timestamp: updated,
          taskId: row.id,
          resultMeta: meta,
        });
      } else {
        messages.push({
          id: `${row.id}-typing`,
          role: "assistant",
          content: "",
          agentId,
          agentName,
          isTyping: true,
          timestamp: created,
          taskId: row.id,
        });
      }
    }
    res.json(messages);
  } catch (err: any) {
    console.error("[api] GET /tasks failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Sonda de arranque: el supervisor de escritorio espera aquí antes de dar la API
// por viva. Tiene que declararse ANTES de "/tasks/:id" o esa ruta se comería
// "health-check" como identificador y respondería 404 para siempre.
api.get("/tasks/health-check", async (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

api.get("/tasks/:id", async (req, res) => {
  try {
    const rows = await (db as any).select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: "internal_error" });
  }
});

api.delete("/tasks/:id", async (req, res) => {
  try {
    await (db as any).delete(tasks).where(eq(tasks.id, req.params.id)).run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] DELETE /tasks/:id failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

api.patch("/tasks/:id/prompt", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? "");
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    await (db as any).update(tasks)
      .set({ prompt, updatedAt: new Date() })
      .where(eq(tasks.id, req.params.id))
      .run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] PATCH /tasks/:id/prompt failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// User profile lives in users/profile.json (single source); the workers read the
// same file to add a [USER PROFILE] block to every agent's system prompt.
const USER_PROFILE_PATH = path.join(usersDir, "profile.json");
const USER_PROFILE_FIELDS = ["name", "email", "occupation", "tools", "interests", "notes"] as const;

async function userAvatarUrl(): Promise<string | null> {
  for (const f of ["avatar.png", "yo.png"]) {
    if (await fileExists(path.join(usersDir, f))) {
      return `/users/${f}?v=${Date.now()}`;
    }
  }
  return null;
}

api.get("/user", async (_req, res) => {
  const empty = Object.fromEntries(USER_PROFILE_FIELDS.map(f => [f, ""]));
  try {
    let profile: any = {};
    try {
      profile = JSON.parse(await readFile(USER_PROFILE_PATH, "utf-8"));
    } catch {
      // Legacy fallback: old DB row from the React era
      const rows = await (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, "user_profile")).limit(1);
      if (rows[0]) profile = JSON.parse(rows[0].value);
    }
    // Legacy schema used "role" for what is now "occupation"
    if (!profile.occupation && profile.role) profile.occupation = profile.role;
    res.json({ ...empty, ...profile, avatarUrl: await userAvatarUrl() });
  } catch {
    res.json({ ...empty, avatarUrl: null });
  }
});

api.post("/user", async (req, res) => {
  try {
    const body = req.body ?? {};
    const profile = Object.fromEntries(USER_PROFILE_FIELDS.map(f => [f, String(body[f] ?? "")]));
    await mkdir(usersDir, { recursive: true });
    await writeFile(USER_PROFILE_PATH, JSON.stringify(profile, null, 2), "utf-8");
    res.json({ success: true, ...profile, avatarUrl: await userAvatarUrl() });
  } catch (err: any) {
    console.error("[api] POST /user failed", err);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

api.post("/user/avatar", (req, res) => {
  userAvatarUpload.single("avatar")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No image file uploaded or invalid format (PNG/JPG/WebP only)" });
    res.json({ success: true, avatarUrl: await userAvatarUrl() });
  });
});

api.get("/system/mcp", async (_req, res) => {
  try {
    const rows = await (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, "mcp_servers_config")).limit(1);
    res.json(rows[0] ? JSON.parse(rows[0].value) : { mcpServers: {} });
  } catch (err: any) {
    console.error("[api] GET /system/mcp failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

api.post("/system/mcp", async (req, res) => {
  try {
    const value = JSON.stringify(req.body ?? { mcpServers: {} });
    await (db as any).insert(systemConfigs)
      .values({ key: "mcp_servers_config", value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfigs.key, set: { value, updatedAt: new Date() } })
      .run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] POST /system/mcp failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// --- Native + my_addons (state key consumed by the workers as native_addons_state) ---

// The registry is only used to enumerate tools for the UI — execute() never runs here.
const addonsRegistry = await createRegistry();

// UI-friendly Spanish descriptions for the built-in tools; custom addons show their own
const ADDON_DESCRIPTION_OVERRIDES: Record<string, string> = {
  web_search: "Busca información actualizada en internet (DuckDuckGo).",
  fetch_url: "Lee una página web y la convierte a Markdown.",
};

api.get("/system/addons", async (_req, res) => {
  try {
    const rows = await (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, "native_addons_state")).limit(1);
    const state = rows[0] ? JSON.parse(rows[0].value) : {};
    // Workers treat anything !== false as enabled
    res.json({
      addons: addonsRegistry.listNative().map(a => ({
        name: a.name,
        description: ADDON_DESCRIPTION_OVERRIDES[a.name] ?? a.description,
        source: a.source,
        enabled: state[a.name] !== false,
      })),
    });
  } catch (err: any) {
    console.error("[api] GET /system/addons failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

api.post("/system/addons", async (req, res) => {
  try {
    const state: Record<string, boolean> = {};
    for (const a of addonsRegistry.listNative()) {
      if (typeof req.body?.[a.name] === "boolean") state[a.name] = req.body[a.name];
    }
    const value = JSON.stringify(state);
    await (db as any).insert(systemConfigs)
      .values({ key: "native_addons_state", value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfigs.key, set: { value, updatedAt: new Date() } })
      .run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] POST /system/addons failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Every worker reports its MCP connections to its own key
// (mcp_servers_status:<worker>) on each heartbeat; here we merge all reports
// with the configured servers so the UI also sees servers that are switched
// off or not yet connected. Best state across workers wins per server.
api.get("/system/mcp/status", async (_req, res) => {
  try {
    const [cfgRows, stRows] = await Promise.all([
      (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, "mcp_servers_config")).limit(1),
      (db as any).select().from(systemConfigs).where(like(systemConfigs.key, "mcp_servers_status:%")),
    ]);
    const config = cfgRows[0] ? JSON.parse(cfgRows[0].value) : { mcpServers: {} };
    const reports: any[][] = stRows.map((r: any) => { try { return JSON.parse(r.value); } catch { return []; } });

    const STATE_RANK: Record<string, number> = { connected: 5, connecting: 4, timeout: 3, failed: 2, disconnected: 1 };
    const bestReport = (name: string) => {
      let best: any = null;
      for (const rep of reports) {
        const st = rep.find((s: any) => s.name === name);
        if (st && (STATE_RANK[st.state] ?? 0) > (best ? STATE_RANK[best.state] ?? 0 : 0)) best = st;
      }
      return best;
    };

    const servers = Object.entries<any>(config.mcpServers ?? {}).map(([name, cfg]) => {
      const st = bestReport(name);
      const enabled = cfg?.switch !== "off";
      return {
        name,
        switch: enabled ? "on" : "off",
        state: !enabled ? "off" : (st?.state ?? "unknown"),
        toolCount: st?.toolCount ?? 0,
        transport: st?.transport ?? "unknown",
        error: st?.error,
      };
    });

    const lastUpdated = stRows.map((r: any) => r.updatedAt).filter(Boolean).sort().pop() ?? null;
    res.json({
      servers,
      lastUpdatedAt: lastUpdated,
      summary: {
        total: servers.length,
        connected: servers.filter(s => s.state === "connected").length,
        off: servers.filter(s => s.state === "off").length,
        errors: servers.filter(s => ["failed", "timeout"].includes(s.state)).length,
      },
    });
  } catch (err: any) {
    console.error("[api] GET /system/mcp/status failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Marca una tarea específica como leída
api.patch("/tasks/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    await (db as any).update(tasks)
      .set({ isRead: true, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] PATCH /tasks/:id/read failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Marca TODAS las tareas de un canal/agente como leídas (al abrir el chat)
api.patch("/agents/:agentId/mark-read", async (req, res) => {
  try {
    const { agentId } = req.params;
    await (db as any).update(tasks)
      .set({ isRead: true, updatedAt: new Date() })
      .where(and(
        eq(tasks.assignedAgent, agentId),
        eq(tasks.status, "completed"),
        eq(tasks.isRead, false)
      ))
      .run();
    res.json({ success: true });
  } catch (err: any) {
    console.error("[api] PATCH /agents/:agentId/mark-read failed", err);
    res.status(500).json({ error: "internal_error" });
  }
});


// Debug endpoint to check DB state
// --- Stats ---

// CPU usage is measured as the delta between consecutive /stats calls, so the
// first reading reflects usage since process start.
function cpuSnapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}
let lastCpuSnapshot = cpuSnapshot();

api.get("/stats", async (_req, res) => {
  try {
    const HEARTBEAT_TIMEOUT_MS = 45_000;
    const now = Date.now();

    const allTasks = await (db as any)
      .select({
        status: tasks.status,
        assignedAgent: tasks.assignedAgent,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        resultMeta: tasks.resultMeta,
      })
      .from(tasks);

    const taskCounts = { total: allTasks.length, completed: 0, failed: 0, pending: 0 };
    for (const t of allTasks) {
      if (t.status === "completed") taskCounts.completed++;
      else if (t.status === "failed") taskCounts.failed++;
      else taskCounts.pending++;
    }

    // Tokens come from resultMeta.usage (chat tasks only — image/video tasks
    // don't report usage); duration is created→updated of completed tasks.
    let totalTokens = 0;
    const durations: number[] = [];
    const perAgentMap = new Map<string, { tokens: number; durations: number[] }>();
    for (const t of allTasks) {
      if (t.status !== "completed") continue;
      const meta = typeof t.resultMeta === "string" ? JSON.parse(t.resultMeta) : t.resultMeta;
      const tokens = Number(meta?.usage?.totalTokens) || 0;
      const durationMs = new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime();
      totalTokens += tokens;
      if (durationMs > 0) durations.push(durationMs);
      if (t.assignedAgent) {
        const entry = perAgentMap.get(t.assignedAgent) ?? { tokens: 0, durations: [] };
        entry.tokens += tokens;
        if (durationMs > 0) entry.durations.push(durationMs);
        perAgentMap.set(t.assignedAgent, entry);
      }
    }
    const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

    const configs = await (db as any).select().from(agentConfigs);
    const isFresh = (hb: unknown) => hb != null && now - new Date(hb as any).getTime() < HEARTBEAT_TIMEOUT_MS;
    const activeAgents = configs.filter((c: any) => isFresh(c.lastHeartbeat)).length;

    const perAgent = configs.map((c: any) => {
      const agentTasks = allTasks.filter((t: any) => t.assignedAgent === c.agentId);
      const stats = perAgentMap.get(c.agentId);
      return {
        agentId: c.agentId,
        online: isFresh(c.lastHeartbeat),
        total: agentTasks.length,
        completed: agentTasks.filter((t: any) => t.status === "completed").length,
        failed: agentTasks.filter((t: any) => t.status === "failed").length,
        tokens: stats?.tokens ?? 0,
        avgMs: avg(stats?.durations ?? []),
      };
    }).sort((a: any, b: any) => b.total - a.total);

    const workerRows = await (db as any).select().from(workerStatus);
    // +1: the API itself is answering this request
    const workersOnline = workerRows.filter((w: any) => isFresh(w.lastHeartbeat)).length + 1;

    const snap = cpuSnapshot();
    const totalDelta = snap.total - lastCpuSnapshot.total;
    const idleDelta = snap.idle - lastCpuSnapshot.idle;
    lastCpuSnapshot = snap;
    const cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;

    const ramTotal = os.totalmem();
    const ramUsed = ramTotal - os.freemem();

    // Task creation counts, today first
    const DAY_MS = 86_400_000;
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const tasksPerDay = Array.from({ length: 7 }, (_, i) => {
      const dayStart = startOfToday.getTime() - i * DAY_MS;
      return {
        date: new Date(dayStart).toISOString().slice(0, 10),
        count: allTasks.filter((t: any) => {
          const ts = new Date(t.createdAt).getTime();
          return ts >= dayStart && ts < dayStart + DAY_MS;
        }).length,
      };
    }).reverse();

    res.json({
      tasks: taskCounts,
      avgResponseMs: avg(durations),
      totalTokens,
      activeAgents,
      totalAgents: configs.length,
      workersOnline,
      system: {
        cpuPercent,
        ramUsedBytes: ramUsed,
        ramTotalBytes: ramTotal,
        ramPercent: Math.round((ramUsed / ramTotal) * 100),
      },
      perAgent,
      tasksPerDay,
    });
  } catch (err) {
    console.error("[api] GET /stats failed", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

// ─── La API, ya completa, bajo su prefijo ────────────────────────────────────
app.use("/api", api);

// ─── La interfaz ─────────────────────────────────────────────────────────────
//
// Un solo puerto sirve la aplicación y los datos, que es lo que hace posible
// abrirla desde otro equipo de la red (y, más adelante, desde un contenedor).
// En desarrollo desde el repositorio el build está en ui/dist; empaquetado, el
// supervisor apunta HYDRA_UI_DIR a resources/ui.
const uiDir = process.env.HYDRA_UI_DIR?.trim() || path.join(appRoot, "ui", "dist", "ui", "browser");

if (existsSync(path.join(uiDir, "index.html"))) {
  app.use(express.static(uiDir, { index: false }));

  // Fallback de la SPA: EL ÚLTIMO de todos. Angular resuelve /agents, /config,
  // /stats… en el cliente, así que una recarga o un enlace directo tienen que
  // devolver index.html en vez de un 404. Se limita a los GET que piden HTML
  // para no tragarse peticiones de datos ni convertir un 404 de la API en una
  // página que el cliente no sabría interpretar.
  app.get(/.*/, (req, res, next) => {
    if (!req.accepts("html")) return next();
    res.sendFile(path.join(uiDir, "index.html"));
  });
  console.log(`[api] serving UI from ${uiDir}`);
} else {
  console.log(`[api] sin build de la interfaz en ${uiDir} — solo API (compílala con: pnpm --filter ui build)`);
}

// Por defecto la API solo escucha en loopback: abrirla a la red tiene que ser
// una decisión explícita (HYDRA_HOST=0.0.0.0) y no el estado de fábrica. Y esa
// decisión exige además HYDRA_AUTH_TOKEN — sin token definido, quien alcance
// el puerto podría crear tareas que ejecutan herramientas y gastan créditos,
// así que la API se niega y cae a loopback avisando en el log.
//
// La variable NO se llama HOST a propósito: csh y tcsh la definen solas con el
// nombre de la máquina, y eso abriría el puerto a la red sin que nadie lo pida.
const port = Number(process.env.PORT ?? 3000);
let host = process.env.HYDRA_HOST?.trim() || "127.0.0.1";
const wantsNetwork = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
if (wantsNetwork && !authToken) {
  console.error(
    `[api] ✖ HYDRA_HOST=${host} sin HYDRA_AUTH_TOKEN — la API NO se abre a la red sin token. ` +
    `Define HYDRA_AUTH_TOKEN en el .env y reinicia; mientras tanto escucho solo en 127.0.0.1.`
  );
  host = "127.0.0.1";
}
app.listen(port, host, () => {
  console.log(`[api] listening on http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`[api] ⚠ escuchando en ${host}: accesible desde la red, protegida por HYDRA_AUTH_TOKEN`);
  }
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

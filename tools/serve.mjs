#!/usr/bin/env node
/**
 * serve.mjs — arranque headless de la pila completa: `pnpm serve`.
 *
 * Levanta NATS + los 8 servicios sin Electron, pensado para un servidor
 * pequeño encendido 24/7 (y para cualquiera que prefiera el navegador a la
 * ventana). Reutiliza el supervisor del escritorio —fases, esperas de salud,
 * adopción de servicios ya vivos, reinicios— que es Node puro y no toca
 * Electron para nada; aquí los hijos corren con el Node del sistema
 * (ELECTRON_RUN_AS_NODE en el entorno es inofensivo bajo un node normal).
 *
 * Antes de arrancar ejecuta migraciones y sembrado de agentes, que son
 * idempotentes: un clon recién hecho funciona sin pasos previos de base de
 * datos, y una actualización aplica su esquema nuevo sola.
 *
 * El binario de nats-server se busca en NATS_SERVER_BIN, en nats/ del
 * repositorio o en el PATH (ver resolveNatsBin en apps/desktop/src/services.js).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dataRoot = process.env.HYDRA_DATA_DIR
  ? path.resolve(process.env.HYDRA_DATA_DIR)
  : repoRoot;
const logDir = path.join(dataRoot, "storage", "logs", "supervisor");

// El .env se carga ANTES de tocar services.js: la resolución del binario de
// NATS (NATS_SERVER_BIN) ocurre al cargar ese módulo. Semántica dotenv: una
// variable ya presente en el entorno real nunca se pisa. Los servicios cargan
// su propio .env igualmente — esto es solo para el supervisor.
try {
  for (const line of fs.readFileSync(path.join(dataRoot, ".env"), "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* sin .env: valores por defecto */ }

const require = createRequire(import.meta.url);
const { ServiceSupervisor, UI_ROOT, NATS_BIN } = require(
  path.join(repoRoot, "apps", "desktop", "src", "services.js")
);

// ─── Avisos tempranos: mejor un mensaje claro ahora que un fallo críptico luego ───

if (!fs.existsSync(path.join(UI_ROOT, "index.html"))) {
  console.warn(`[serve] ⚠ interfaz sin compilar en ${UI_ROOT} — la API servirá solo datos. Compílala con: pnpm --filter ui build`);
}

// El supervisor lanzará NATS_BIN; si es un nombre a secas lo resolverá el PATH,
// y ahí no podemos comprobar nada por adelantado — el fallo se verá al lanzar.
if (path.isAbsolute(NATS_BIN) && !fs.existsSync(NATS_BIN)) {
  console.error(`[serve] ✖ no existe el binario de NATS en ${NATS_BIN}. Instala nats-server (o define NATS_SERVER_BIN).`);
  process.exit(1);
}

// ─── Migraciones + sembrado, idempotentes, en cada arranque ──────────────────

function runOnce(scriptRel) {
  return new Promise((resolve) => {
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, scriptRel)], {
      cwd: repoRoot,
      env: { ...process.env, HYDRA_DATA_DIR: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    child.on("exit", (code) => resolve({ code, output }));
    child.on("error", (err) => resolve({ code: -1, output: String(err) }));
  });
}

console.log("[serve] aplicando migraciones…");
const migrate = await runOnce(path.join("packages", "db", "src", "migrate.ts"));
if (migrate.code !== 0) {
  console.error(`[serve] ✖ las migraciones fallaron — no se arranca nada con la base de datos a medias:\n${migrate.output}`);
  process.exit(1);
}
const seed = await runOnce(path.join("packages", "db", "src", "seed-agent-configs.ts"));
if (seed.code !== 0) {
  console.warn(`[serve] ⚠ el sembrado de agentes falló (la pila arranca igual):\n${seed.output}`);
}

// ─── Arranque por fases con el supervisor del escritorio ─────────────────────

const supervisor = new ServiceSupervisor({ logDir, dataRoot, isPackaged: false });

// Toda la salida de los servicios pasa por aquí con su prefijo: en consola se
// lee como docker compose, y bajo systemd acaba entera en el journal. Cada
// servicio escribe además su propio archivo en storage/logs/.
supervisor.on("log", ({ id, chunk }) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) console.log(`[${id}] ${line}`);
  }
});

supervisor.on("status", (s) => {
  if (s.status === "crashed") console.error(`[serve] ✖ ${s.label}: ${s.detail || "caído"}`);
  if (s.status === "external") console.log(`[serve] ${s.label}: ${s.detail}`);
});

await supervisor.startAll((msg) => console.log(`[serve] ${msg}`));

// Sin NATS o sin API la pila no es una pila: mejor pararlo todo y salir con
// error (systemd lo reintentará) que quedarse a medias aparentando servicio.
const snapshot = supervisor.snapshot();
const essential = snapshot.filter((s) => s.id === "nats" || s.id === "api" || s.id === "key-proxy");
const broken = essential.filter((s) => s.status === "crashed");
if (broken.length) {
  console.error(`[serve] ✖ no arrancó: ${broken.map((s) => s.label).join(", ")} — se detiene la pila`);
  await supervisor.stopAll();
  process.exit(1);
}

// ─── Resumen y URL ───────────────────────────────────────────────────────────

for (const s of snapshot) {
  const mark = s.status === "running" ? "✔" : s.status === "external" ? "≡" : "✖";
  console.log(`[serve]  ${mark} ${s.label}${s.status === "external" ? " (adoptado)" : ""}`);
}

// El .env (ya cargado arriba) manda sobre dónde escucha la API; aquí solo se
// usa para imprimir la URL buena.
const host = process.env.HYDRA_HOST?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "3000";

console.log(`[serve] interfaz en http://127.0.0.1:${port}`);
if (host === "0.0.0.0") {
  // La API se niega a abrirse a la red sin token (cae a loopback): imprimir
  // URLs de red sin token sería mentir.
  if (process.env.HYDRA_AUTH_TOKEN?.trim()) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) console.log(`[serve]          http://${a.address}:${port} (red local)`);
      }
    }
  } else {
    console.warn("[serve] ⚠ HYDRA_HOST=0.0.0.0 sin HYDRA_AUTH_TOKEN: la API se queda en loopback");
  }
}
console.log("[serve] Ctrl+C para parar la pila");

// ─── Apagado limpio ──────────────────────────────────────────────────────────

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[serve] ${signal}: parando la pila…`);
  await supervisor.stopAll();
  console.log("[serve] pila detenida");
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Los hijos mantienen vivo el proceso; esto cubre el caso extremo de que todos
// mueran y agoten sus reintentos — el supervisor sigue siendo el ancla.
setInterval(() => {}, 1 << 30);

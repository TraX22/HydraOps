#!/usr/bin/env node
/**
 * make-screenshots.mjs — capturas del manual, regenerables con un comando:
 *
 *   node tools/make-screenshots.mjs
 *
 * Levanta la pila COMPLETA contra una carpeta de datos de demostración
 * (build/demo-data, se borra y se siembra en cada ejecución: nada del usuario
 * sale en las imágenes), crea tres agentes de ejemplo por la API, espera a que
 * los workers los marquen online, y con un Chromium sin cabeza (Playwright)
 * captura las vistas del manual en español y en inglés.
 *
 * Salida: docs/img/{es,en}/*.png — comprimidas con sharp (paleta) porque van
 * al repositorio. Las páginas del manual las referencian como ../img/<lang>/x.png.
 *
 * Requisitos: pnpm build + pnpm --filter ui build hechos, puerto 3000 LIBRE
 * (el script se niega si hay otra pila viva: saldrían los datos reales).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const dataRoot = path.join(repoRoot, "build", "demo-data");
const outRoot = path.join(repoRoot, "docs", "img");
const BASE = "http://127.0.0.1:3000";

const AGENTS = [
  { name: "Elena", workerType: "general", emoji: "🤖" },
  { name: "Iris", workerType: "graphic", emoji: "🎨" },
  { name: "Nova", workerType: "coder", emoji: "💻" },
];

// Vista → captura. `prepare` recibe la page de Playwright ya navegada.
const SHOTS = [
  { name: "overview", url: "/", prepare: async (page, lang) => {
      const msg = lang === "es"
        ? "Hola Elena, ¿me resumes las novedades de esta semana?"
        : "Hi Elena, can you summarize this week's news for me?";
      await page.fill("textarea.input-field", msg);
    } },
  { name: "agents", url: "/agents", prepare: async (page) => {
      await page.click(".agent-card");
      await page.waitForSelector(".agent-detail", { timeout: 5000 });
    } },
  { name: "config", url: "/config" },
  { name: "addons", url: "/addons" },
  { name: "cron", url: "/tasks", prepare: async (page) => {
      await page.click(".add-btn");
      await page.waitForSelector(".cron-form", { timeout: 5000 });
    } },
  { name: "docs", url: "/docs?page=agents" },
  { name: "login", url: "/login" },
];

async function alive() {
  try {
    const r = await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function runOnce(scriptRel, env) {
  return new Promise((resolve) => {
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, scriptRel)], {
      cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    child.on("exit", (code) => resolve({ code, output }));
    child.on("error", (err) => resolve({ code: -1, output: String(err) }));
  });
}

// ─── 0. Nadie más en el 3000: las capturas serían de los datos reales ────────

if (await alive()) {
  console.error("[shots] ✖ hay una pila HydraOps viva en el 3000. Párala (Ctrl+C en su terminal) y vuelve a lanzar esto.");
  process.exit(1);
}

if (!fs.existsSync(path.join(repoRoot, "ui", "dist", "ui", "browser", "index.html"))) {
  console.error("[shots] ✖ interfaz sin compilar. Antes: pnpm --filter ui build");
  process.exit(1);
}

// ─── 1. Datos de demostración desde cero ─────────────────────────────────────

fs.rmSync(dataRoot, { recursive: true, force: true });
fs.mkdirSync(dataRoot, { recursive: true });
// Los directorios de datos que en el repo existen de por sí (agents/ con su
// .gitkeep, etc.); en un dataRoot virgen nadie los crea y la API da ENOENT.
for (const d of ["agents", "users", "my_addons", "storage/uploads", "storage/results", "storage/logs"]) {
  fs.mkdirSync(path.join(dataRoot, d), { recursive: true });
}
// El esquema de entorno (zod) exige estas dos; los servicios leen el .env de
// SU dataRoot, así que la demo lleva el suyo — mínimo y sin tocar el real.
fs.writeFileSync(path.join(dataRoot, ".env"),
  "DATABASE_URL=sqlite:///db.sqlite3\nNATS_URL=nats://127.0.0.1:4222\n");
const env = { ...process.env, HYDRA_DATA_DIR: dataRoot };
delete env.HYDRA_HOST;        // loopback: sin token, sin red
delete env.HYDRA_AUTH_TOKEN;

console.log("[shots] migraciones + sembrado en build/demo-data…");
const migrate = await runOnce(path.join("packages", "db", "src", "migrate.ts"), env);
if (migrate.code !== 0) {
  console.error(`[shots] ✖ migraciones fallaron:\n${migrate.output}`);
  process.exit(1);
}
await runOnce(path.join("packages", "db", "src", "seed-agent-configs.ts"), env);

// ─── 2. La pila entera, con el supervisor del escritorio ─────────────────────

const { ServiceSupervisor } = require(path.join(repoRoot, "apps", "desktop", "src", "services.js"));
// El supervisor pone HYDRA_DATA_DIR de su dataRoot en los hijos; los servicios
// leen su .env de ESA carpeta (no existe en la demo), así que ni HYDRA_HOST ni
// token ni LLM local del .env real se cuelan. Por si este proceso los tuviera:
delete process.env.HYDRA_HOST;
delete process.env.HYDRA_AUTH_TOKEN;
const supervisor = new ServiceSupervisor({
  logDir: path.join(dataRoot, "storage", "logs", "supervisor"),
  dataRoot,
  isPackaged: false,
});

console.log("[shots] arrancando la pila de demostración…");
await supervisor.startAll((msg) => console.log(`[shots]   ${msg}`));

const broken = supervisor.snapshot().filter((s) => s.status === "crashed");
if (broken.length) {
  console.error(`[shots] ✖ no arrancó: ${broken.map((s) => s.label).join(", ")}`);
  await supervisor.stopAll();
  process.exit(1);
}

let exitCode = 0;
try {
  // ─── 3. Agentes de demostración y espera del latido ────────────────────────
  for (const a of AGENTS) {
    const r = await fetch(`${BASE}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    });
    if (!r.ok) throw new Error(`POST /agents ${a.name}: ${r.status}`);
  }
  console.log("[shots] agentes creados; esperando el latido de los workers (25 s)…");
  await new Promise((r) => setTimeout(r, 25_000));

  // ─── 4. Capturas ───────────────────────────────────────────────────────────
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const lang of ["es", "en"]) {
    const outDir = path.join(outRoot, lang);
    fs.mkdirSync(outDir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
    });
    await ctx.addInitScript(([l]) => {
      localStorage.setItem("hydra_lang", l);
      localStorage.setItem("hydra_theme", "light"); // el tema del manual: día
    }, [lang]);

    const page = await ctx.newPage();
    for (const shot of SHOTS) {
      await page.goto(`${BASE}${shot.url}`, { waitUntil: "networkidle" });
      if (shot.prepare) await shot.prepare(page, lang);
      await page.waitForTimeout(400); // animaciones de entrada
      await page.screenshot({ path: path.join(outDir, `${shot.name}.png`) });
      console.log(`[shots]   ${lang}/${shot.name}.png`);
    }
    await ctx.close();
  }
  await browser.close();

  // ─── 5. Compresión: van al repositorio ─────────────────────────────────────
  const sharp = createRequire(path.join(repoRoot, "apps", "api", "package.json"))("sharp");
  for (const lang of ["es", "en"]) {
    for (const f of fs.readdirSync(path.join(outRoot, lang))) {
      const p = path.join(outRoot, lang, f);
      const buf = await sharp(p).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
      fs.writeFileSync(p, buf);
    }
  }
  const total = ["es", "en"].flatMap((l) =>
    fs.readdirSync(path.join(outRoot, l)).map((f) => fs.statSync(path.join(outRoot, l, f)).size),
  ).reduce((a, b) => a + b, 0);
  console.log(`[shots] ✔ ${SHOTS.length * 2} capturas en docs/img/{es,en} (${Math.round(total / 1024)} KB en total)`);
} catch (err) {
  console.error("[shots] ✖", err);
  exitCode = 1;
} finally {
  console.log("[shots] parando la pila de demostración…");
  await supervisor.stopAll();
}
process.exit(exitCode);

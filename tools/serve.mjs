#!/usr/bin/env node
/**
 * serve.mjs — headless start of the whole stack: `pnpm serve`.
 *
 * Brings up NATS + the services without Electron, meant for a small server
 * that stays on 24/7 (and for anyone who prefers the browser to the window).
 * It reuses the desktop supervisor — phases, health waits, adoption of
 * services already alive, restarts — which is plain Node and never touches
 * Electron; here the children run with the system's Node
 * (ELECTRON_RUN_AS_NODE in the environment is harmless under a normal node).
 *
 * Before starting it runs the migrations and the agent seeding, both
 * idempotent: a fresh clone works with no database steps, and an update
 * applies its new schema by itself.
 *
 * The nats-server binary is looked up in NATS_SERVER_BIN, in nats/ of the
 * repository or in the PATH (see resolveNatsBin in apps/desktop/src/services.js).
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
const envFile = path.join(dataRoot, ".env");

/** The variables of the .env, as written there (quotes stripped); empty without a file. */
function readEnvFile() {
  const values = {};
  try {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env: defaults */ }
  return values;
}

// The .env is loaded BEFORE touching services.js: the NATS binary lookup
// (NATS_SERVER_BIN) happens when that module loads. dotenv semantics: a
// variable already present in the real environment is never overwritten. The
// services load their own .env anyway — this is only for the supervisor.
for (const [name, value] of Object.entries(readEnvFile())) {
  if (!(name in process.env)) process.env[name] = value;
}

// The children learn who runs the stack: /exit and /restart only work under a supervisor.
process.env.HYDRA_SUPERVISOR = "server";

const require = createRequire(import.meta.url);
const { ServiceSupervisor, UI_ROOT, NATS_BIN } = require(
  path.join(repoRoot, "apps", "desktop", "src", "services.js")
);

// ─── Early warnings: a clear message now beats a cryptic failure later ───────

if (!fs.existsSync(path.join(UI_ROOT, "index.html"))) {
  console.warn(`[serve] ⚠ UI not built in ${UI_ROOT} — the API will serve data only. Build it with: pnpm --filter ui build`);
}

// The supervisor launches NATS_BIN; a bare name is resolved by the PATH, and
// there is nothing to check ahead of time — a failure shows up at launch.
if (path.isAbsolute(NATS_BIN) && !fs.existsSync(NATS_BIN)) {
  console.error(`[serve] ✖ no NATS binary at ${NATS_BIN}. Install nats-server (or set NATS_SERVER_BIN).`);
  process.exit(1);
}

// ─── Migrations + seeding, idempotent, on every start ────────────────────────

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

console.log("[serve] applying migrations…");
const migrate = await runOnce(path.join("packages", "db", "src", "migrate.ts"));
if (migrate.code !== 0) {
  console.error(`[serve] ✖ migrations failed — nothing starts on a half-migrated database:\n${migrate.output}`);
  process.exit(1);
}
const seed = await runOnce(path.join("packages", "db", "src", "seed-agent-configs.ts"));
if (seed.code !== 0) {
  console.warn(`[serve] ⚠ agent seeding failed (the stack starts anyway):\n${seed.output}`);
}

// ─── Phased start with the desktop supervisor ────────────────────────────────

const supervisor = new ServiceSupervisor({ logDir, dataRoot, isPackaged: false });

// Every service's output goes through here with its prefix: on a console it
// reads like docker compose, and under systemd it all lands in the journal.
// Each service also writes its own file in storage/logs/.
supervisor.on("log", ({ id, chunk }) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) console.log(`[${id}] ${line}`);
  }
});

supervisor.on("status", (s) => {
  if (s.status === "crashed") console.error(`[serve] ✖ ${s.label}: ${s.detail || "crashed"}`);
  if (s.status === "external") console.log(`[serve] ${s.label}: ${s.detail}`);
});

await supervisor.startAll((msg) => console.log(`[serve] ${msg}`));

// Without NATS or the API the stack is no stack: better to stop everything and
// exit with an error (systemd retries) than to stay half up pretending to serve.
const snapshot = supervisor.snapshot();
const essential = snapshot.filter((s) => s.id === "nats" || s.id === "api" || s.id === "key-proxy");
const broken = essential.filter((s) => s.status === "crashed");
if (broken.length) {
  console.error(`[serve] ✖ did not start: ${broken.map((s) => s.label).join(", ")} — stopping the stack`);
  await supervisor.stopAll();
  process.exit(1);
}

// ─── Summary and URLs ────────────────────────────────────────────────────────

for (const s of snapshot) {
  const mark = s.status === "running" ? "✔" : s.status === "external" ? "≡" : "✖";
  console.log(`[serve]  ${mark} ${s.label}${s.status === "external" ? " (adopted)" : ""}`);
}

// The .env (loaded above) decides where the API listens; here it is only used
// to print the right URLs.
const host = process.env.HYDRA_HOST?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "3000";

console.log(`[serve] UI at http://127.0.0.1:${port}`);
if (host === "0.0.0.0") {
  // On its first start on the network the API generates HYDRA_AUTH_TOKEN itself and
  // saves it in the .env, after this process loaded its environment: the file is
  // the truth, not process.env. Without a token the API refuses the network and
  // stays on loopback, so printing network URLs would be lying.
  const token = process.env.HYDRA_AUTH_TOKEN?.trim() || readEnvFile().HYDRA_AUTH_TOKEN?.trim();
  if (token) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) console.log(`[serve]       http://${a.address}:${port} (local network, asks for HYDRA_AUTH_TOKEN)`);
      }
    }
  } else {
    console.warn("[serve] ⚠ HYDRA_HOST=0.0.0.0 but no HYDRA_AUTH_TOKEN could be saved in the .env: the API stays on loopback");
  }
}
console.log("[serve] Ctrl+C stops the stack");

// ─── Self-update (the "Update" button of the UI) ─────────────────────────────
// The API writes the request; here git+rebuild run and the services restart in
// place. It only has an effect on a git checkout (the API checks before queueing).
const { watchForUpdateRequest } = require(path.join(repoRoot, "apps", "desktop", "src", "self-update.js"));
watchForUpdateRequest({
  repoRoot,
  dataRoot,
  stopAll: () => supervisor.stopAll(),
  startAll: () => supervisor.startAll((msg) => console.log(`[serve] ${msg}`)),
});

// ─── Clean shutdown ──────────────────────────────────────────────────────────

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[serve] ${signal}: stopping the stack…`);
  await supervisor.stopAll();
  console.log("[serve] stack stopped");
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// /exit and /restart from the chat or Telegram: the API writes the request once the user
// confirmed; here it is carried out (see apps/desktop/src/power.js).
const { watchForPowerRequest } = require(path.join(repoRoot, "apps", "desktop", "src", "power.js"));
watchForPowerRequest({
  dataRoot,
  log: (msg) => console.log(`[serve] ${msg}`),
  onShutdown: (req) => shutdown(`/exit (${req.by})`),
  onRestart: async (req) => {
    if (stopping) return;
    console.log(`[serve] /restart (${req.by}): restarting the stack…`);
    await supervisor.stopAll();
    await supervisor.startAll((msg) => console.log(`[serve] ${msg}`));
    console.log("[serve] stack restarted");
  },
});

// The children keep the process alive; this covers the edge case of all of them
// dying and running out of retries — the supervisor remains the anchor.
setInterval(() => {}, 1 << 30);

/**
 * backup.js — copies of what makes this installation the user's, and putting one back.
 *
 * Shared by the API (which makes copies while the stack runs) and by both supervisors
 * (tools/serve.mjs and main.js, which put a copy back while the stack is stopped), the
 * same way self-update.js and power.js are.
 *
 * A copy is a folder under <dataRoot>/backups/<name>/ with a manifest.json and the items
 * it holds: the database, agents/, skills/, my_addons/, users/ and .env always; storage/
 * (uploads, results, scenes; never the logs) and the keys (keys.json and chatgpt.json,
 * which live outside the data folder) only when asked. A folder, not an archive: nothing
 * to unpack, the user can look inside, copy it elsewhere or delete it.
 *
 * Putting one back cannot happen from the API: eight services hold the database open.
 * The API writes restore.request in dataRoot; the supervisor watching it stops the stack,
 * keeps the current state as a copy of its own (kind "before-restore"), replaces the
 * items the chosen copy holds, and relaunches. The migrations run on the next boot, as
 * they do after an update, so a copy from an older version comes forward on its own.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const BACKUPS_DIR = "backups";
const DB_FILE = "db.sqlite3";
// What every copy holds, relative to dataRoot. The database is handled apart (see copyDb).
const BASE_ITEMS = ["agents", "skills", "my_addons", "users", ".env"];
const STORAGE_ITEM = "storage";
const STORAGE_SKIP = new Set(["logs"]);
const KEY_FILES = ["keys.json", "chatgpt.json"];
const KEYS_ITEM = "keys";
const KINDS = new Set(["manual", "before-update", "before-restore"]);
const KEEP_AUTO = 5;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const backupsDir = (dataRoot) => path.join(dataRoot, BACKUPS_DIR);
const restoreRequestFile = (dataRoot) => path.join(dataRoot, "restore.request");
const restoreStateFile = (dataRoot) => path.join(dataRoot, "restore.state.json");

const isValidName = (name) => typeof name === "string" && NAME_RE.test(name) && name !== "." && name !== "..";

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function sizeOf(target) {
  const st = await fsp.stat(target).catch(() => null);
  if (!st) return 0;
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of await fsp.readdir(target, { withFileTypes: true }).catch(() => [])) total += await sizeOf(path.join(target, e.name));
  return total;
}

async function readManifest(dir) {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
    if (!m || m.schema !== 1 || !isValidName(m.name) || !Array.isArray(m.items)) return null;
    return m;
  } catch {
    return null;
  }
}

/** The copies that exist, newest first. A folder without a readable manifest is not one. */
async function listBackups(dataRoot) {
  const root = backupsDir(dataRoot);
  const out = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !isValidName(e.name)) continue;
    const m = await readManifest(path.join(root, e.name));
    if (m && m.name === e.name) out.push(m);
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function copyItem(from, to, filter) {
  if (!fs.existsSync(from)) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false, ...(filter ? { filter } : {}) });
  return true;
}

/**
 * Makes a copy. `copyDb(dest)` writes a consistent copy of the database to `dest`: the
 * API passes SQLite's online backup (the stack is running), a supervisor a plain file copy
 * (the stack is stopped). Returns the manifest.
 */
async function createBackup({ dataRoot, keyStoreDir, version, kind = "manual", label = "", storage = false, keys = false, copyDb }) {
  if (!KINDS.has(kind)) throw new Error(`unknown backup kind "${kind}"`);
  const safeLabel = String(label || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const name = [stamp(), kind, safeLabel].filter(Boolean).join("_");
  const dir = path.join(backupsDir(dataRoot), name);
  if (fs.existsSync(dir)) throw new Error(`a copy named "${name}" already exists`);
  await fsp.mkdir(dir, { recursive: true });
  const items = [];
  try {
    const dbSrc = path.join(dataRoot, DB_FILE);
    if (fs.existsSync(dbSrc)) {
      const dest = path.join(dir, DB_FILE);
      if (copyDb) await copyDb(dest); else await fsp.copyFile(dbSrc, dest);
      items.push(DB_FILE);
    }
    for (const item of BASE_ITEMS) {
      if (await copyItem(path.join(dataRoot, item), path.join(dir, item))) items.push(item);
    }
    if (storage) {
      const src = path.join(dataRoot, STORAGE_ITEM);
      const skip = (p) => !STORAGE_SKIP.has(path.relative(src, p).split(path.sep)[0] || "");
      if (await copyItem(src, path.join(dir, STORAGE_ITEM), skip)) items.push(STORAGE_ITEM);
    }
    if (keys && keyStoreDir) {
      let any = false;
      for (const f of KEY_FILES) {
        if (await copyItem(path.join(keyStoreDir, f), path.join(dir, KEYS_ITEM, f))) any = true;
      }
      if (any) items.push(KEYS_ITEM);
    }
    const manifest = {
      schema: 1,
      name,
      kind,
      label: safeLabel,
      at: new Date().toISOString(),
      version: String(version || ""),
      items,
      storage: items.includes(STORAGE_ITEM),
      keys: items.includes(KEYS_ITEM),
      size: 0,
    };
    manifest.size = await sizeOf(dir);
    await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Removes a copy. Only a name that lists as a copy is accepted. */
async function deleteBackup(dataRoot, name) {
  if (!isValidName(name)) throw new Error("invalid name");
  const dir = path.join(backupsDir(dataRoot), name);
  if (!(await readManifest(dir))) throw new Error("no such copy");
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Keeps the newest `keep` automatic copies of each kind (before-update, before-restore); manual ones stay. */
async function pruneAutomatic(dataRoot, keep = KEEP_AUTO) {
  const removed = [];
  const all = await listBackups(dataRoot);
  for (const kind of ["before-update", "before-restore"]) {
    const ofKind = all.filter((m) => m.kind === kind);
    for (const m of ofKind.slice(keep)) {
      await fsp.rm(path.join(backupsDir(dataRoot), m.name), { recursive: true, force: true }).catch(() => {});
      removed.push(m.name);
    }
  }
  return removed;
}

/**
 * Puts a copy back, with the stack STOPPED. The current state is kept first as a copy of
 * kind "before-restore", so a restore can itself be undone. Only the items the copy holds
 * are replaced: a copy without storage leaves the current storage alone. Returns what it did.
 */
async function restoreBackup({ dataRoot, keyStoreDir, name, version, log = () => {} }) {
  if (!isValidName(name)) throw new Error("invalid name");
  const dir = path.join(backupsDir(dataRoot), name);
  const m = await readManifest(dir);
  if (!m) throw new Error(`there is no copy named "${name}"`);
  const kept = await createBackup({ dataRoot, keyStoreDir, version, kind: "before-restore", label: m.name.slice(0, 19), storage: m.items.includes(STORAGE_ITEM), keys: m.items.includes(KEYS_ITEM) });
  log(`current state kept as ${kept.name}`);
  const restored = [];
  for (const item of m.items) {
    if (item === KEYS_ITEM) {
      if (!keyStoreDir) continue;
      for (const f of KEY_FILES) {
        const src = path.join(dir, KEYS_ITEM, f);
        if (fs.existsSync(src)) { await fsp.mkdir(keyStoreDir, { recursive: true }); await fsp.copyFile(src, path.join(keyStoreDir, f)); }
      }
      restored.push(item);
      continue;
    }
    if (item !== DB_FILE && !BASE_ITEMS.includes(item) && item !== STORAGE_ITEM) continue; // not something a copy holds
    const src = path.join(dir, item);
    const dest = path.join(dataRoot, item);
    if (!fs.existsSync(src)) continue;
    if (item === DB_FILE) {
      // A journal left by a crash would be replayed against the restored file: drop it.
      for (const suffix of ["-journal", "-wal", "-shm"]) await fsp.rm(dest + suffix, { force: true }).catch(() => {});
      await fsp.copyFile(src, dest);
    } else if (item === STORAGE_ITEM) {
      // Replace what the copy holds (uploads, results, scenes); the logs are not in it and stay.
      for (const e of await fsp.readdir(src, { withFileTypes: true })) {
        await fsp.rm(path.join(dest, e.name), { recursive: true, force: true });
        await fsp.cp(path.join(src, e.name), path.join(dest, e.name), { recursive: true, force: true });
      }
    } else {
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(src, dest, { recursive: true, force: true });
    }
    restored.push(item);
  }
  log(`restored ${restored.join(", ")} from ${name}`);
  return { name, restored, kept: kept.name };
}

// ─── The request the API leaves and the supervisor carries out ───────────────────

function readRestoreState(dataRoot) {
  try { return JSON.parse(fs.readFileSync(restoreStateFile(dataRoot), "utf8")); } catch { return null; }
}
function writeRestoreState(dataRoot, state) {
  try { fs.writeFileSync(restoreStateFile(dataRoot), JSON.stringify(state), "utf8"); } catch { /* best effort */ }
}

/** Reads and removes the request, or returns null when there is none (or it is not one). */
function takeRestoreRequest(dataRoot) {
  const file = restoreRequestFile(dataRoot);
  if (!fs.existsSync(file)) return null;
  let req = null;
  try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* not ours */ }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  if (!req || !isValidName(req.name)) return null;
  return { name: req.name, by: typeof req.by === "string" ? req.by.slice(0, 120) : "unknown", at: Number(req.at) || Date.now() };
}

/**
 * Watches for the request. When one appears: a short grace for the tasks the API already
 * cancelled, `stopAll()`, the restore, then `relaunch()` (the new supervisor's boot runs
 * the migrations and starts the stack). Returns a function that stops watching.
 */
function watchForRestoreRequest({ dataRoot, keyStoreDir, version, stopAll, relaunch, graceMs = 3000, pollMs = 1000, log = () => {} }) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    const req = takeRestoreRequest(dataRoot);
    if (!req) return;
    busy = true;
    log(`restore of ${req.name} requested by ${req.by}: stopping the stack in ${Math.round(graceMs / 1000)} s`);
    writeRestoreState(dataRoot, { status: "running", name: req.name, startedAt: Date.now() });
    try {
      await new Promise((r) => setTimeout(r, graceMs));
      await stopAll();
      const done = await restoreBackup({ dataRoot, keyStoreDir, name: req.name, version, log });
      writeRestoreState(dataRoot, { status: "restarting", name: req.name, kept: done.kept, restored: done.restored, startedAt: Date.now() });
      log("restored: relaunching");
      await relaunch();
    } catch (e) {
      const error = (e && e.message) || String(e);
      log(`restore failed: ${error}`);
      writeRestoreState(dataRoot, { status: "error", name: req.name, error });
      // The stack is down: bring it back as it was, so the user is not left without the app.
      try { await relaunch(); } catch { /* nothing more to do */ }
    } finally {
      busy = false;
    }
  }, pollMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/** On a supervisor's boot: a restore that was relaunching is now done. Returns true when it was. */
function finishRestore(dataRoot) {
  const s = readRestoreState(dataRoot);
  if (!s || s.status !== "restarting") return false;
  writeRestoreState(dataRoot, { ...s, status: "success", finishedAt: Date.now() });
  return true;
}

module.exports = {
  BACKUPS_DIR, KEEP_AUTO, backupsDir, restoreRequestFile, restoreStateFile, isValidName,
  listBackups, readManifest, createBackup, deleteBackup, pruneAutomatic, restoreBackup,
  readRestoreState, writeRestoreState, takeRestoreRequest, watchForRestoreRequest, finishRestore,
};

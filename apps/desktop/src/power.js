/**
 * power.js — the /exit and /restart commands, on the supervisor's side.
 *
 * Shared by the headless supervisor (tools/serve.mjs) and the desktop one (main.js), the
 * same way self-update.js is. The API only WRITES a request (power.request in dataRoot)
 * once the user confirmed the command; here that file is watched and, when it appears,
 * the tasks in progress get a few seconds to save their state and then the supervisor
 * stops the stack (shutdown) or stops and starts it again (restart). The API process
 * cannot do either: it is one of the children.
 */
const fs = require("node:fs");
const path = require("node:path");

const requestFile = (dataRoot) => path.join(dataRoot, "power.request");
const ACTIONS = new Set(["shutdown", "restart"]);
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_POLL_MS = 1000;

/** Reads and removes the request, or returns null when there is none (or it is not one). */
function takeRequest(dataRoot) {
  const file = requestFile(dataRoot);
  if (!fs.existsSync(file)) return null;
  let req = null;
  try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* not ours */ }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  if (!req || !ACTIONS.has(req.action)) return null;
  return { action: req.action, by: typeof req.by === "string" ? req.by.slice(0, 120) : "unknown", at: Number(req.at) || Date.now() };
}

/**
 * Watches for the request. `onShutdown(req)` / `onRestart(req)` are called once the grace
 * period passed; the restart handler is awaited and, while it runs, no other request is
 * read. Returns a function that stops watching.
 */
function watchForPowerRequest({ dataRoot, onShutdown, onRestart, graceMs = DEFAULT_GRACE_MS, pollMs = DEFAULT_POLL_MS, log = () => {} }) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    const req = takeRequest(dataRoot);
    if (!req) return;
    busy = true;
    try {
      log(`${req.action} requested by ${req.by}: waiting ${Math.round(graceMs / 1000)} s for tasks in progress`);
      await new Promise((r) => setTimeout(r, graceMs));
      if (req.action === "shutdown") await onShutdown(req);
      else await onRestart(req);
    } catch (e) {
      log(`${req.action} failed: ${(e && e.message) || e}`);
    } finally {
      busy = false;
    }
  }, pollMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { requestFile, takeRequest, watchForPowerRequest };

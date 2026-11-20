/**
 * reveal.js — what to show in the system's file manager for a path the interface asks about.
 *
 * The interface sends the place of a project's file in the user's own folder. Nothing is
 * ever opened or run with the answer: the caller only selects the item in the folder that
 * holds it, whether it is a file or a folder. A file that does not exist yet (one the agent
 * created and the user has not accepted) falls back to the closest folder that does.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {unknown} input The path asked for.
 * @returns {{ kind: "file" | "folder", path: string } | null} What to show, or null when
 *   the path is not one to act on (not absolute, or nothing of it exists).
 */
function revealTarget(input) {
  const asked = typeof input === "string" ? input.trim() : "";
  // Windows device and network paths (\\server\share, \\?\, \\.\) are not project files:
  // touching one makes the system reach out to another machine.
  if (!asked || asked.includes("\0") || !path.isAbsolute(asked) || /^[\\/]{2}/.test(asked)) return null;
  let current = path.normalize(asked);
  for (let depth = 0; depth < 64; depth++) {
    let stat = null;
    try { stat = fs.statSync(current); } catch { /* not there: try its parent */ }
    if (stat) {
      // The path asked for, as it is: a file is selected in its folder, a folder is shown.
      if (depth === 0 && !stat.isDirectory()) return { kind: "file", path: current };
      if (stat.isDirectory()) return { kind: "folder", path: current };
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

module.exports = { revealTarget };

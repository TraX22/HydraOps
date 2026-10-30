/**
 * Files only the current user may read: the key store (keys.json, chatgpt.json, x.json).
 *
 * The store is plain JSON, not encrypted (see docs/en/13-security.md for why), so its
 * protection is the file system's: on Linux and macOS mode 600 on the file and 700 on
 * the folder; on Windows an access list that names the current user alone, with the
 * inherited entries (Users, Authenticated Users…) removed. Node's `mode` does nothing on
 * Windows, which is why icacls is called there.
 *
 * Every write goes through a temp file and a rename, so a reader never sees a half file
 * and a crash never leaves the store empty.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Who the Windows access list names: DOMAIN\user, which also resolves local accounts. */
function windowsAccount(): string {
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function icacls(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("icacls", args, { windowsHide: true, timeout: 60_000, encoding: "utf-8" }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }));
  });
}

/**
 * Leaves `target` readable and writable by the current user only. Best effort: a failure
 * (an exotic account, a file system without ACLs) is not an error, because the store still
 * has to work; the result says whether it took.
 */
export async function restrictToOwner(target: string, kind: "file" | "dir"): Promise<boolean> {
  if (process.platform === "win32") {
    // (OI)(CI) on a folder: files created inside inherit the same single entry.
    const grant = kind === "dir" ? `${windowsAccount()}:(OI)(CI)F` : `${windowsAccount()}:F`;
    return (await icacls([target, "/inheritance:r", "/grant:r", grant, "/Q"])).ok;
  }
  try {
    await chmod(target, kind === "dir" ? 0o700 : 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * The store folder is only ours on a case-sensitive file system. On Windows and macOS
 * `%APPDATA%\hydraops` and `%APPDATA%\HydraOps` (the data root: data/, backups/, shell/) are
 * the SAME folder, so its permissions must never be touched there: 0.1.82 did, Windows
 * propagated the change into data/ and left the database and the .env unreadable.
 */
const DIR_IS_OURS = process.platform === "linux";

/** The files the store is made of; nothing else in the folder is touched. */
export const PRIVATE_STORE_FILES = new Set(["keys.json", "chatgpt.json", "x.json", "master.key"]);

/** Writes `text` to `file` so that only the current user can read it. */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (DIR_IS_OURS) await restrictToOwner(dir, "dir");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: "utf-8", mode: 0o600 });
  await restrictToOwner(tmp, "file");
  await rename(tmp, file);
}

/**
 * Tightens the store files of an existing installation (world-readable 644 on Linux, the
 * inherited entries on Windows) and, where the folder is ours alone, the folder. Called once
 * when the key-proxy starts. Returns the paths it could not tighten, for the log.
 */
export async function securePrivateDir(dir: string): Promise<string[]> {
  const failed: string[] = [];
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return [dir];
  }
  if (DIR_IS_OURS && !(await restrictToOwner(dir, "dir"))) failed.push(dir);
  await repairSharedFolder(dir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return failed;
  }
  for (const name of names) {
    if (!PRIVATE_STORE_FILES.has(name)) continue;
    const full = path.join(dir, name);
    if (!(await restrictToOwner(full, "file"))) failed.push(full);
  }
  return failed;
}

/**
 * Undoes what 0.1.82 did on Windows: the data folders beside the store had their inherited
 * permissions removed and their contents left with none. Resetting them to inherit from the
 * (healthy) parent restores the defaults; the store files themselves are set afterwards.
 */
async function repairSharedFolder(dir: string): Promise<void> {
  if (process.platform !== "win32") return;
  for (const sub of ["data", "backups", "shell"]) {
    const full = path.join(dir, sub);
    try {
      if (!(await stat(full)).isDirectory()) continue;
    } catch {
      continue;
    }
    const own = await icacls([full]);
    // Healthy folders list inherited entries, marked (I); a damaged one shows only an explicit grant.
    if (own.ok && /\(I\)/.test(own.out)) continue;
    await icacls([full, "/reset", "/T", "/C", "/Q"]);
  }
}

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
import { chmod, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Who the Windows access list names: DOMAIN\user, which also resolves local accounts. */
function windowsAccount(): string {
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function icacls(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("icacls", args, { windowsHide: true, timeout: 15_000 }, (err) => resolve(!err));
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
    return icacls([target, "/inheritance:r", "/grant:r", grant, "/Q"]);
  }
  try {
    await chmod(target, kind === "dir" ? 0o700 : 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Writes `text` to `file` so that only the current user can read it, creating a private folder if needed. */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrictToOwner(dir, "dir");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: "utf-8", mode: 0o600 });
  await restrictToOwner(tmp, "file");
  await rename(tmp, file);
}

/**
 * Tightens an existing store folder and every file in it: installations from before this
 * existed left the folder and keys.json with the system defaults (world-readable on Linux,
 * inherited entries on Windows). Called once when the key-proxy starts. Returns the paths
 * it could not tighten, for the log.
 */
export async function securePrivateDir(dir: string): Promise<string[]> {
  const failed: string[] = [];
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return [dir];
  }
  if (!(await restrictToOwner(dir, "dir"))) failed.push(dir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return failed;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if (!(await restrictToOwner(full, "file"))) failed.push(full);
  }
  return failed;
}

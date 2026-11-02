import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

/**
 * The conversation names files by where the app keeps them, relative to its storage:
 * an attachment as "storage/uploads/<name>", a file a task produced as
 * "results/<task>/<name>". The native tools resolve those themselves; a connection's
 * tool (an MCP server) gets its arguments verbatim and, being another program, looks
 * the relative path up in its own folder and fails. Before a call to a connection that
 * runs on this computer, every argument that names such a file is turned into the
 * file's absolute path. Only a reference to an existing file inside this task's folder
 * or the uploads folder changes; any other value is left exactly as it came.
 */
const UPLOAD_REF = /^(?:storage\/)?uploads\/([^/]+)$/;
const RESULT_REF = /^(?:storage\/)?results\/([^/]+)\/([^/]+)$/;
const MAX_DEPTH = 6;

export interface TaskPathRoots { filesDir?: string; uploadsDir?: string }

/** The absolute path of a conversation file reference, or null when it names none. */
export async function resolveTaskPath(value: string, roots: TaskPathRoots): Promise<string | null> {
  const ref = value.trim().replace(/\\/g, '/');
  let root: string | undefined;
  let name: string | undefined;
  const up = UPLOAD_REF.exec(ref);
  const rs = RESULT_REF.exec(ref);
  if (up) { root = roots.uploadsDir; name = up[1]; }
  else if (rs && roots.filesDir && path.basename(roots.filesDir) === rs[1]) { root = roots.filesDir; name = rs[2]; }
  if (!root || !name || name === '.' || name === '..') return null;
  const base = await realpath(root).catch(() => '');
  if (!base) return null;
  const real = await realpath(path.join(base, name)).catch(() => '');
  if (!real || path.dirname(real) !== base) return null;
  const st = await stat(real).catch(() => null);
  return st?.isFile() ? real : null;
}

/** `args` with every file reference resolved, in strings, arrays and plain objects; everything else untouched. */
export async function resolveTaskPathsInArgs(args: unknown, roots: TaskPathRoots, depth = 0): Promise<unknown> {
  if (depth > MAX_DEPTH || (!roots.filesDir && !roots.uploadsDir)) return args;
  if (typeof args === 'string') return (await resolveTaskPath(args, roots)) ?? args;
  if (Array.isArray(args)) return Promise.all(args.map((v) => resolveTaskPathsInArgs(v, roots, depth + 1)));
  if (args && typeof args === 'object' && Object.getPrototypeOf(args) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) out[k] = await resolveTaskPathsInArgs(v, roots, depth + 1);
    return out;
  }
  return args;
}

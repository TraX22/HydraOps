/**
 * Files a task produced for the user: a tool that leaves one in the task's folder (a
 * generated 3D model, for instance) reports it here, and the worker stores the list in the
 * task's result. That is how the chat knows there is something to show or download next to
 * the answer; the answer's text does not have to name a path for it.
 */
import path from 'node:path';
import { closeSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Size plus a hash of the first and last MB: the same file brought in twice under two names is recognised. */
function fingerprint(absPath: string, size: number): string | null {
  try {
    const fd = openSync(absPath, 'r');
    try {
      const h = createHash('sha1');
      const chunk = Buffer.alloc(Math.min(size, 1 << 20));
      h.update(chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, 0)));
      if (size > chunk.length) h.update(chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, size - chunk.length)));
      return `${size}:${h.digest('hex')}`;
    } finally { closeSync(fd); }
  } catch { return null; }
}

export type ResultFileKind = 'model' | 'image' | 'video' | 'audio' | 'file';

export interface ResultFile {
  /** Relative to the storage folder, with forward slashes: what `/storage/<path>` serves. */
  path: string;
  name: string;
  kind: ResultFileKind;
  size: number;
  /** A 3D model's triangle count, when the tool measured it. */
  triangles?: number;
}

export interface ReportedFile { absPath: string; kind: ResultFileKind; size: number; triangles?: number }

const KINDS: readonly ResultFileKind[] = ['model', 'image', 'video', 'audio', 'file'];
const MAX_FILES = 20;

export function createResultFiles(storageDir: string): { add: (file: ReportedFile) => void; list: () => ResultFile[] } {
  const root = path.resolve(storageDir);
  const files: ResultFile[] = [];
  const seen = new Set<string>();
  return {
    add(file) {
      if (!file || typeof file.absPath !== 'string' || files.length >= MAX_FILES) return;
      const abs = path.resolve(file.absPath);
      const rel = path.relative(root, abs);
      // Only what is inside the storage folder can be served to the chat.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      const relPath = rel.split(path.sep).join('/');
      if (files.some((f) => f.path === relPath)) return;
      const size = Number(file.size);
      // The same content under another name (a connection's tool and comfy_workflows collect
      // both bringing the job's image): one card is enough.
      const fp = Number.isFinite(size) && size > 0 ? fingerprint(abs, size) : null;
      if (fp && seen.has(fp)) return;
      if (fp) seen.add(fp);
      const triangles = Number(file.triangles);
      files.push({
        path: relPath,
        name: path.basename(abs),
        kind: KINDS.includes(file.kind) ? file.kind : 'file',
        size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
        ...(Number.isFinite(triangles) && triangles > 0 ? { triangles: Math.floor(triangles) } : {}),
      });
    },
    list: () => files.map((f) => ({ ...f })),
  };
}

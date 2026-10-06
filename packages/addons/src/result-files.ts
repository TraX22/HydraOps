/**
 * Files a task produced for the user: a tool that leaves one in the task's folder (a
 * generated 3D model, for instance) reports it here, and the worker stores the list in the
 * task's result. That is how the chat knows there is something to show or download next to
 * the answer; the answer's text does not have to name a path for it.
 */
import path from 'node:path';

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

import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { ResultFile } from './result-files.js';

/**
 * The files the recent replies of a conversation left (an image a workflow saved, a model,
 * a crop image_edit made), so the next request can be about them: "now remove its
 * background" names the picture the previous task produced. They come from the same tasks
 * the chat history is built from (resultMeta.files), newest first; the agent sees them as
 * a short list with the path the app shows, and the tools that take a file (image_edit,
 * comfy_workflows, a local connection) accept exactly those paths, read-only: whatever a
 * tool produces still goes to the current task's folder.
 */
export interface ConversationFile extends ResultFile {
  /** The task whose reply left the file. */
  taskId: string;
  /** Where the file is on disk. */
  absPath: string;
  /** When that task finished (ISO). */
  at: string;
}

const MAX_FILES = 12;

/** From the history rows (tasks with resultMeta), newest first, at most `max` files. */
export function conversationFiles(storageDir: string, rows: any[], max = MAX_FILES): ConversationFile[] {
  const root = path.resolve(storageDir);
  const sorted = [...(Array.isArray(rows) ? rows : [])].filter((r) => r && typeof r.id === 'string')
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  const out: ConversationFile[] = [];
  const seen = new Set<string>();
  for (const row of sorted) {
    const files: unknown = row.resultMeta?.files;
    if (!Array.isArray(files)) continue;
    const at = String(row.resultMeta?.completedAt ?? (row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt ?? ''));
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !f.path.startsWith('results/') || seen.has(f.path)) continue;
      const rel = f.path.split('/');
      if (rel.length < 3 || rel.some((p: string) => p === '..' || p === '')) continue;
      seen.add(f.path);
      out.push({
        path: f.path, name: typeof f.name === 'string' && f.name ? f.name : rel[rel.length - 1],
        kind: f.kind ?? 'file', size: Number.isFinite(Number(f.size)) ? Number(f.size) : 0,
        ...(Number(f.triangles) > 0 ? { triangles: Number(f.triangles) } : {}),
        taskId: String(row.id), absPath: path.join(root, ...rel), at,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

const human = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' '); };

/** The prompt section listing them; empty when there are none. */
export function conversationFilesPrompt(files: ConversationFile[]): string {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path} — ${f.kind}, ${human(f.size)}${f.triangles ? `, ${f.triangles} triangles` : ''}${when(f.at) ? `, from your reply of ${when(f.at)}` : ''}`);
  return `\n\n## Files from earlier in this conversation\nThe user may mean one of these ("that image", "the model you made"). Pass the path exactly as written to image_edit, to comfy_workflows (in "files") or to a connection's tool; they are read-only, and what you produce goes to this task's folder as usual.\n${lines.join('\n')}`;
}

/**
 * The file a reference names among the conversation's files, or null: the path as the
 * list shows it ("results/<task>/<name>", a "storage/" prefix or backslashes tolerated),
 * and only if it is still there. A bare name is not enough: it could be anything.
 */
export async function resolveConversationFile(ref: string, files: ConversationFile[] | undefined): Promise<ConversationFile | null> {
  if (!files?.length || typeof ref !== 'string') return null;
  const wanted = ref.trim().replace(/\\/g, '/').replace(/^storage\//, '');
  const hit = files.find((f) => f.path === wanted);
  if (!hit) return null;
  const real = await realpath(hit.absPath).catch(() => '');
  if (!real) return null;
  const st = await stat(real).catch(() => null);
  return st?.isFile() ? { ...hit, absPath: real } : null;
}

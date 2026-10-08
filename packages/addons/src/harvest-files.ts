/**
 * harvest-files.ts — media an MCP tool left on this computer, brought into the chat.
 *
 * A connection's tool may finish by naming where it saved its output: ComfyUI's
 * fetch_outputs answers with a temporary folder's path and the server's /view address, an
 * image or 3D server with the file it wrote. Natives report their files themselves
 * (addResultFile); an MCP server cannot, so its answer would stay a path in the text and
 * the user would see nothing. Here every image, video, audio or 3D file the result names
 * (an existing local path, or a /view address on this computer) is copied into the task's
 * folder and reported, so it gets its card under the reply like a generated image does.
 *
 * Narrow on purpose: media extensions only, files up to MAX_BYTES, addresses only on this
 * computer (127.0.0.1 / localhost), at most MAX_FILES per result. The tool's answer to the
 * model is not changed.
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportedFile, ResultFileKind } from "./result-files.js";

const EXT_KIND: Record<string, ResultFileKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".bmp": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".flac": "audio", ".m4a": "audio",
  ".glb": "model", ".gltf": "model", ".obj": "model", ".fbx": "model", ".stl": "model", ".ply": "model",
};
const EXTS = Object.keys(EXT_KIND).map((e) => e.slice(1)).join("|");
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_FILES = 8;
const FETCH_TIMEOUT_MS = 60_000;

const WIN_PATH = new RegExp(String.raw`[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+\.(?:${EXTS})(?![A-Za-z0-9])`, "gi");
const POSIX_PATH = new RegExp(String.raw`(?<![A-Za-z0-9:/.])/(?:[^\s"'<>|/]+/)+[^\s"'<>|/]+\.(?:${EXTS})(?![A-Za-z0-9])`, "gi");
const LOCAL_VIEW_URL = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?:api\/)?view\?[^\s"'<>)\]]+/gi;

export const mediaKindOf = (name: string): ResultFileKind | null => EXT_KIND[path.extname(name).toLowerCase()] ?? null;

/** Every string inside a result (a JSON text is parsed first), so escaped paths read as paths. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 500) return out;
  if (typeof value === "string") {
    out.push(value);
    const t = value.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length < 2_000_000) {
      try { strings(JSON.parse(t), out, depth + 1); } catch { /* not JSON */ }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) strings(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) strings(v, out, depth + 1);
  }
  return out;
}

/** The media files and local /view addresses a result names, without duplicates. */
export function findMediaRefs(result: unknown): { paths: string[]; urls: string[] } {
  const paths = new Set<string>();
  const urls = new Set<string>();
  for (const raw of strings(result)) {
    // A JSON text followed by a note does not parse: its Windows paths still carry escaped
    // backslashes ("C:\\Users\\…"), read here as single ones.
    const s = raw.includes("\\\\") ? raw.replace(/\\\\/g, "\\") : raw;
    for (const m of s.match(WIN_PATH) ?? []) paths.add(m);
    for (const m of s.match(POSIX_PATH) ?? []) paths.add(m);
    for (const m of s.match(LOCAL_VIEW_URL) ?? []) {
      try {
        const u = new URL(m.replace(/&amp;/g, "&"));
        if (mediaKindOf(u.searchParams.get("filename") ?? "")) urls.add(u.toString());
      } catch { /* not a URL */ }
    }
  }
  return { paths: [...paths], urls: [...urls] };
}

const safeName = (name: string) => path.basename(name).replace(/[^A-Za-z0-9 ._-]+/g, "_").slice(0, 120) || "file";

async function freeName(dir: string, name: string, size: number): Promise<{ target: string; exists: boolean }> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 1; i < 100; i++) {
    const target = path.join(dir, i === 1 ? name : `${stem}_${i}${ext}`);
    const st = await stat(target).catch(() => null);
    if (!st) return { target, exists: false };
    if (st.size === size) return { target, exists: true };   // the same file was already brought in
  }
  return { target: path.join(dir, `${stem}_${Date.now()}${ext}`), exists: false };
}

/**
 * Copies the media a result names into `filesDir` and reports each one. Best effort:
 * returns how many were reported, never throws.
 */
export async function harvestMediaFiles(result: unknown, ctx: { filesDir?: string; addResultFile?: (f: ReportedFile) => void; storageDir?: string }): Promise<number> {
  if (!ctx.filesDir || !ctx.addResultFile) return 0;
  const found = findMediaRefs(result);
  const paths = found.paths;
  // A result that names the saved file also gives its /view address (ComfyUI): the local
  // copy is enough. The addresses count only when no path came with them.
  const urls = paths.length ? [] : found.urls;
  // The task's folder is storage/results/<task>: its storage folder is two levels up.
  const storageDir = ctx.storageDir ?? path.dirname(path.dirname(ctx.filesDir));
  if (!paths.length && !urls.length) return 0;
  let reported = 0;
  try {
    await mkdir(ctx.filesDir, { recursive: true });
    for (const p of paths) {
      if (reported >= MAX_FILES) break;
      const kind = mediaKindOf(p);
      const st = kind ? await stat(p).catch(() => null) : null;
      if (!kind || !st?.isFile() || st.size === 0 || st.size > MAX_BYTES) continue;
      const abs = path.resolve(p);
      // Already inside the storage folder (a native tool's own file): report it as it is.
      if (!path.relative(path.resolve(storageDir), abs).startsWith("..")) {
        ctx.addResultFile({ absPath: abs, kind, size: st.size });
        reported++;
        continue;
      }
      const { target, exists } = await freeName(ctx.filesDir, safeName(abs), st.size);
      if (!exists) await copyFile(abs, target);
      ctx.addResultFile({ absPath: target, kind, size: st.size });
      reported++;
    }
    for (const u of urls) {
      if (reported >= MAX_FILES) break;
      const name = safeName(new URL(u).searchParams.get("filename") ?? "file");
      const kind = mediaKindOf(name);
      if (!kind) continue;
      const res = await fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
      if (!res?.ok) continue;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const { target, exists } = await freeName(ctx.filesDir, name, buf.length);
      if (!exists) await writeFile(target, buf);
      ctx.addResultFile({ absPath: target, kind, size: buf.length });
      reported++;
    }
  } catch (e: any) {
    console.warn(`[harvest] could not bring a tool's media into the task: ${e?.message ?? e}`);
  }
  return reported;
}

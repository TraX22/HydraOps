import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HydraTool, ToolContext } from "../../types.js";
import { comfyBaseUrl } from "../comfy_workflows/index.js";

// comfy_download_model — a model file downloaded into the folder ComfyUI itself reads.
//
// The ComfyUI connection's own download_model writes into comfy-cli's workspace, which is
// often not where the user's ComfyUI lives (a portable build, another disk, extra model
// paths), and it refuses when the connection names an address. ComfyUI knows where it reads
// each kind of model: it lists the folders at /internal/folder_paths. This tool asks it,
// and downloads there, so any install works without telling HydraOps where it is.
//
// It acts on the user's machine with content from the internet, so every call waits for the
// user's approval. Only https, only weights formats that cannot run code when loaded
// (.safetensors, .gguf), never over an existing file, and only for a ComfyUI on this
// computer (on another machine the folders ComfyUI reports are on that machine). A file of
// several gigabytes takes minutes: the download goes on in the background and
// comfy_workflows' action "downloads" tells how far it got.

const EXTENSIONS = /\.(safetensors|sft|gguf)$/i;
const NAME_RE = /^[\w.\-+()\[\] ]{1,180}$/;
const HEADER_WAIT_MS = Number(process.env.HYDRA_COMFY_DOWNLOAD_HEADER_MS) || 30_000;
// A download that receives nothing for this long is stuck, and is cut (tests shorten it).
const STALL_MS = Number(process.env.HYDRA_COMFY_DOWNLOAD_STALL_MS) || 60_000;

export type DownloadState = "downloading" | "done" | "failed" | "interrupted";
export interface DownloadEntry {
  id: string; url: string; file: string; dest: string; folder: string;
  state: DownloadState; bytes: number; total: number | null; startedAt: string; finishedAt?: string; error?: string;
}

// Live progress of this process's downloads; the note on disk survives a restart.
const live = new Map<string, DownloadEntry>();

const isLoopbackHost = (h: string) => /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(h);
const isPrivateHost = (h: string) =>
  isLoopbackHost(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(h) || /^\[?(fc|fd|fe80)/i.test(h);
// Tests serve the file over http on 127.0.0.1; nothing else may.
const testHttp = () => process.env.HYDRA_COMFY_DOWNLOAD_TEST_HTTP === "1";

export function downloadNotePath(uploadsDir: string | undefined, agentId: string | undefined): string | null {
  if (!uploadsDir || !agentId || !/^[\w-]{1,64}$/.test(agentId)) return null;
  return path.join(path.dirname(uploadsDir), "comfy-downloads", `${agentId}.json`);
}

async function readNote(p: string | null): Promise<DownloadEntry[]> {
  if (!p) return [];
  try { const v = JSON.parse(await readFile(p, "utf-8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function writeNote(p: string | null, entries: DownloadEntry[]): Promise<void> {
  if (!p) return;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(entries.slice(-20), null, 1));
}
async function saveEntry(p: string | null, e: DownloadEntry): Promise<void> {
  const all = (await readNote(p)).filter((x) => x.id !== e.id);
  all.push(e);
  await writeNote(p, all);
}

/** The folder ComfyUI reads for `folder` (its own name for a kind of model), on this computer. */
export async function modelFolder(base: string, folder: string): Promise<{ dir: string } | { error: string }> {
  let paths: Record<string, unknown>;
  try {
    const r = await fetch(`${base}/internal/folder_paths`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { error: `ComfyUI answered HTTP ${r.status} when asked for its model folders` };
    paths = (await r.json()) as Record<string, unknown>;
  } catch { return { error: `ComfyUI did not answer at ${base}; it has to be running` }; }
  const kinds = Object.keys(paths).filter((k) => Array.isArray(paths[k])).sort();
  const list = paths[folder];
  if (!Array.isArray(list)) return { error: `ComfyUI has no model folder called "${folder}". Its folders: ${kinds.join(", ")}` };
  // Entries with a stray comment from extra_model_paths.yaml, and the output folders ComfyUI
  // also lists, are not where a model belongs.
  const usable = list.map(String).filter((d) => d && !d.includes("#") && !/[\\/]output[\\/]/i.test(d + path.sep));
  const preferred = [...usable.filter((d) => path.basename(d.replace(/[\\/]+$/, "")).toLowerCase() === folder.toLowerCase()), ...usable];
  for (const d of preferred) {
    try { if ((await stat(d)).isDirectory()) return { dir: d }; } catch { /* listed but missing: next */ }
  }
  if (preferred.length) {
    try { await mkdir(preferred[0], { recursive: true }); return { dir: preferred[0] }; } catch { /* fall through */ }
  }
  return { error: `none of the folders ComfyUI lists for "${folder}" exists on this computer` };
}

function fileNameOf(url: URL, given?: string): string | null {
  const name = (given?.trim() || decodeURIComponent(url.pathname.split("/").pop() || "")).trim();
  return NAME_RE.test(name) && EXTENSIONS.test(name) && !name.startsWith(".") ? name : null;
}

const human = (n: number | null) => n === null ? "unknown size" : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

/** Starts the download; resolves once the server answered (or failed), the body keeps flowing. */
async function start(urlText: string, folder: string, given: string | undefined, ctx: ToolContext | undefined): Promise<string> {
  const base = comfyBaseUrl(ctx?.connectionEnv?.("comfyui")?.COMFYUI_URL || process.env.COMFYUI_URL);
  const baseHost = new URL(base).hostname;
  if (!isLoopbackHost(baseHost)) {
    return `Not downloaded: ComfyUI runs at ${base}, on another machine. A model has to be downloaded on that machine, into its own ComfyUI; tell the user.`;
  }
  let url: URL;
  try { url = new URL(urlText.trim()); } catch { return "Not downloaded: that is not a valid address."; }
  const httpOk = testHttp() && url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !httpOk) return "Not downloaded: only https addresses are accepted.";
  if (!httpOk && isPrivateHost(url.hostname)) return "Not downloaded: the address points into this computer or its local network.";
  const file = fileNameOf(url, given);
  if (!file) return "Not downloaded: the file has to be a .safetensors or .gguf model (formats that cannot run code when ComfyUI loads them), with a plain file name. Pass \"filename\" when the address does not end in one.";
  const where = await modelFolder(base, folder);
  if ("error" in where) return `Not downloaded: ${where.error}.`;
  const dest = path.join(where.dir, file);
  try { const s = await stat(dest); return `Already installed: ${dest} (${human(s.size)}). Nothing was downloaded.`; } catch { /* not there: go on */ }

  const note = downloadNotePath(ctx?.uploadsDir, ctx?.agentId);
  const entry: DownloadEntry = { id: `${Date.now().toString(36)}-${file}`, url: url.toString(), file, dest, folder, state: "downloading", bytes: 0, total: null, startedAt: new Date().toISOString() };
  const part = `${dest}.part`;
  // The answer has to start within HEADER_WAIT_MS; after that the body may take as long as it
  // needs, and only a stall (no data for STALL_MS) cuts it. A timeout signal on the whole
  // fetch would also cut a healthy multi-gigabyte download.
  const abort = new AbortController();
  const headerTimer = setTimeout(() => abort.abort(new Error("no answer in 30 seconds")), HEADER_WAIT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: abort.signal });
  } catch (e: any) {
    clearTimeout(headerTimer);
    return `Not downloaded: the server did not answer (${abort.signal.aborted ? "no answer in 30 seconds" : e?.message ?? e}).`;
  }
  clearTimeout(headerTimer);
  const finalUrl = new URL(res.url || url.toString());
  if (finalUrl.protocol !== "https:" && !(testHttp() && isLoopbackHost(finalUrl.hostname))) return "Not downloaded: the address redirected to a non-https location.";
  if (res.status === 401 || res.status === 403) return `Not downloaded: the server answered ${res.status} — this model needs a login or accepting its terms on the site (Hugging Face "gated" models do). The user can download it in the browser and put it in ${where.dir}.`;
  if (!res.ok || !res.body) return `Not downloaded: the server answered HTTP ${res.status}.`;
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type)) return "Not downloaded: the address returned a web page, not a file. Use the file's direct download link (on Hugging Face, the one with /resolve/ in it).";
  const len = Number(res.headers.get("content-length"));
  entry.total = Number.isFinite(len) && len > 0 ? len : null;
  live.set(entry.id, entry);
  await saveEntry(note, entry);

  // The body goes on after this call returns; progress lives in `live` and the note.
  let lastSaved = 0;
  let lastData = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastData > STALL_MS) abort.abort(new Error(`no data for ${STALL_MS / 1000} seconds`));
  }, 5_000);
  stallTimer.unref?.();
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => {
    entry.bytes += chunk.length;
    lastData = Date.now();
    if (Date.now() - lastSaved > 5_000) { lastSaved = Date.now(); void saveEntry(note, { ...entry }); }
  });
  void (async () => {
    try {
      await pipeline(body, createWriteStream(part));
      if (entry.total !== null && entry.bytes !== entry.total) throw new Error(`the download stopped at ${human(entry.bytes)} of ${human(entry.total)}`);
      await rename(part, dest);
      entry.state = "done";
    } catch (e: any) {
      entry.state = "failed";
      entry.error = String(e?.message ?? e).slice(0, 300);
      await rm(part, { force: true }).catch(() => {});
    }
    clearInterval(stallTimer);
    entry.finishedAt = new Date().toISOString();
    live.delete(entry.id);
    await saveEntry(note, entry);
    console.log(`[comfy_download_model] ${file}: ${entry.state}${entry.error ? ` (${entry.error})` : ""}`);
  })();

  return [
    `Downloading ${file} (${human(entry.total)}) into ${where.dir}, the folder ComfyUI reads for ${folder}.`,
    "It goes on in the background: tell the user it is downloading and end your reply. When they ask, comfy_workflows with action \"downloads\" says how far it got; once it is done, validate the workflow again.",
  ].join("\n");
}

/** What this agent downloaded lately, with live progress for the ones still going. */
export async function downloadsReport(ctx: { uploadsDir?: string; agentId?: string }): Promise<string> {
  const note = downloadNotePath(ctx.uploadsDir, ctx.agentId);
  const entries = await readNote(note);
  if (!entries.length) return "No model downloads by this agent.";
  const lines = entries.slice(-8).reverse().map((saved) => {
    const e = live.get(saved.id) ?? saved;
    // A download the note says is running but this process does not hold was cut by a restart.
    const state: DownloadState = e.state === "downloading" && !live.has(e.id) ? "interrupted" : e.state;
    const pct = e.total ? ` ${Math.floor((e.bytes / e.total) * 100)} %` : "";
    if (state === "downloading") return `- ${e.file}: downloading,${pct} (${human(e.bytes)} of ${human(e.total)}), into ${path.dirname(e.dest)}`;
    if (state === "done") return `- ${e.file}: done, ${human(e.bytes)} in ${e.dest}`;
    if (state === "interrupted") return `- ${e.file}: interrupted at ${human(e.bytes)} (HydraOps restarted); ask the user before downloading it again`;
    return `- ${e.file}: failed (${e.error ?? "no detail"})`;
  });
  return `Model downloads by this agent, newest first:\n${lines.join("\n")}`;
}

export const comfyDownloadModelTool: HydraTool = {
  name: "comfy_download_model",
  title: "Download a model into ComfyUI",
  // Writes a file from the internet onto the user's disk: every call waits for approval.
  risk: { sensitive: true, approval: "always" },
  description:
    "Download a model file into the folder the user's ComfyUI reads for that kind of model, when a workflow needs a model that is not installed. " +
    "Use the file's direct link (on Hugging Face, the /resolve/ one) from the model's official page, never a guessed address, and say its size to the user when the page shows it. " +
    "Only .safetensors and .gguf, only https, never over an existing file, and only for a ComfyUI on this computer. The user approves every download. " +
    "It starts the download and returns: tell the user it is downloading and end; comfy_workflows action \"downloads\" shows the progress. Prefer this over the connection's download_model, which writes into comfy-cli's own folder.",
  schema: z.object({
    url: z.string().min(8).describe("The file's direct https download link."),
    folder: z.string().min(1).max(64).describe('The kind of model, as ComfyUI names its folders: "diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "clip_vision", "upscale_models"…'),
    filename: z.string().optional().describe("The file name to save it as, only when the link does not end in it."),
  }),
  execute: async ({ url, folder, filename }, ctx) => start(String(url), String(folder).trim(), filename, ctx),
};

import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HydraTool, ToolContext } from "../../types.js";
import { comfyBaseUrl } from "../comfy_workflows/index.js";
import { adultAllowed } from "../civitai/index.js";

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
//
// Hugging Face and Civitai links go through the key-proxy for their first request, so a gated
// model (Hugging Face, with the user's token and accepted terms) or one behind a sign-in
// (Civitai, with the user's key) downloads too. The proxy adds the key only for that site
// and hands the redirect back instead of following it: the file itself comes from the
// site's CDN through a signed link, without the key. A Civitai model marked adult is not
// downloaded while the user keeps adult content blocked (Herramientas → Civitai).

const EXTENSIONS = /\.(safetensors|sft|gguf)$/i;
// Letters and digits of any language, and a few marks; never a path separator or a control character.
const NAME_RE = /^[\p{L}\p{N}_.\-+()\[\] ]{1,180}$/u;
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
  let name = given?.trim() || "";
  if (!name) { try { name = decodeURIComponent(url.pathname.split("/").pop() || ""); } catch { name = ""; } }
  return validName(name.trim());
}
const validName = (name: string): string | null => (NAME_RE.test(name) && EXTENSIONS.test(name) && !name.startsWith(".") ? name : null);

/** The file name a download answer gives (Content-Disposition), or the last part of its address. */
function nameFromAnswer(res: Response, finalUrl: URL): string | null {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  const plainName = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  for (const raw of [star?.[1], plainName?.[1]]) {
    if (!raw) continue;
    let n = raw.trim().replace(/^"|"$/g, "");
    try { n = decodeURIComponent(n); } catch { /* keep as is */ }
    const ok = validName(path.basename(n));
    if (ok) return ok;
  }
  return fileNameOf(finalUrl);
}

type Site = { name: "Hugging Face" | "Civitai"; prefix: "huggingface" | "civitai"; host: string };
/** A site whose first request goes through the key-proxy; civitai.red and hf.co are the same services. */
function siteOf(url: URL): Site | null {
  const h = url.hostname.toLowerCase().replace(/^www\./, "");
  if (h === "huggingface.co" || h === "hf.co") return { name: "Hugging Face", prefix: "huggingface", host: "huggingface.co" };
  if (h === "civitai.com" || h === "civitai.red") return { name: "Civitai", prefix: "civitai", host: "civitai.com" };
  return null;
}
const proxyBase = () => (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").trim().replace(/\/$/, "");

/**
 * The download's answer. For a site, the first request (and any redirect inside the site)
 * goes through the key-proxy with redirects handed back; the CDN link it ends at is fetched
 * directly. `noKey` says the proxy had no key to add.
 */
async function openDownload(url: URL, signal: AbortSignal): Promise<{ res: Response; finalUrl: URL; noKey: boolean } | string> {
  const site = siteOf(url);
  if (!site) {
    const res = await fetch(url, { redirect: "follow", signal });
    return { res, finalUrl: new URL(res.url || url.toString()), noKey: false };
  }
  let at = new URL(url.toString());
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(`${proxyBase()}/${site.prefix}${at.pathname}${at.search}`, { redirect: "manual", signal });
    const noKey = res.headers.get("x-hydra-no-key") === "1";
    if (res.status < 300 || res.status >= 400) return { res, finalUrl: at, noKey };
    const loc = res.headers.get("location");
    if (!loc) return `${site.name} answered a redirect without an address`;
    const next = new URL(loc, `https://${site.host}${at.pathname}`);
    void res.body?.cancel();
    if (siteOf(next)?.prefix === site.prefix) { at = next; continue; }
    const cdnOk = next.protocol === "https:" ? !isPrivateHost(next.hostname) : testHttp() && isLoopbackHost(next.hostname);
    if (!cdnOk) return "the address redirected to a non-https or local location";
    const cdn = await fetch(next, { redirect: "follow", signal });
    return { res: cdn, finalUrl: new URL(cdn.url || next.toString()), noKey };
  }
  return `${site.name} redirected too many times`;
}

/** A Civitai download link names a model version; one marked adult is refused while adult content is blocked. */
async function civitaiAdultCheck(url: URL): Promise<string | null> {
  const m = /^\/api\/download\/models\/(\d+)/.exec(url.pathname);
  if (!m || (await adultAllowed())) return null;
  try {
    const r = await fetch(`${proxyBase()}/civitai/api/v1/model-versions/${m[1]}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return `Civitai did not say what model version ${m[1]} is (HTTP ${r.status}), and adult content is blocked, so it is not downloaded.`;
    const d: any = await r.json();
    // The model's own mark, the same rule as the civitai tools (a version's nsfwLevel adds up its example images).
    if (d?.model?.nsfw === true) return "This Civitai model is marked as adult content, which is blocked in HydraOps (Herramientas → Civitai); it is not downloaded.";
    return null;
  } catch { return "Civitai could not be asked what this model is, and adult content is blocked, so it is not downloaded."; }
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
  const site = siteOf(url);
  if (url.hostname.toLowerCase().replace(/^www\./, "") === "civitai.red") url.hostname = "civitai.com";
  const NAME_HELP = "the file has to be a .safetensors or .gguf model (formats that cannot run code when ComfyUI loads them), with a plain file name";
  let file = fileNameOf(url, given);
  // A Civitai link (…/api/download/models/<id>) does not end in the name; its answer gives it.
  if (!file && !(site?.prefix === "civitai" && !given)) return `Not downloaded: ${NAME_HELP}. Pass "filename" when the address does not end in one.`;
  const where = await modelFolder(base, folder);
  if ("error" in where) return `Not downloaded: ${where.error}.`;
  if (file) {
    try { const s = await stat(path.join(where.dir, file)); return `Already installed: ${path.join(where.dir, file)} (${human(s.size)}). Nothing was downloaded.`; } catch { /* not there: go on */ }
  }
  if (site?.prefix === "civitai") {
    const refused = await civitaiAdultCheck(url);
    if (refused) return `Not downloaded: ${refused}`;
  }
  // The answer has to start within HEADER_WAIT_MS; after that the body may take as long as it
  // needs, and only a stall (no data for STALL_MS) cuts it. A timeout signal on the whole
  // fetch would also cut a healthy multi-gigabyte download.
  const abort = new AbortController();
  const headerTimer = setTimeout(() => abort.abort(new Error("no answer in 30 seconds")), HEADER_WAIT_MS);
  let opened: Awaited<ReturnType<typeof openDownload>>;
  try {
    opened = await openDownload(url, abort.signal);
  } catch (e: any) {
    clearTimeout(headerTimer);
    return `Not downloaded: the server did not answer (${abort.signal.aborted ? "no answer in 30 seconds" : e?.message ?? e}).`;
  }
  clearTimeout(headerTimer);
  if (typeof opened === "string") return `Not downloaded: ${opened}.`;
  const { res, finalUrl, noKey } = opened;
  if (finalUrl.protocol !== "https:" && !(testHttp() && isLoopbackHost(finalUrl.hostname))) return "Not downloaded: the address redirected to a non-https location.";
  if (res.status === 401 || res.status === 403) {
    void res.body?.cancel();
    const fix = site?.prefix === "huggingface"
      ? (noKey ? "This model is gated: add a Hugging Face token in Herramientas → Hugging Face, and accept the model's terms on its page with that account." : "The token's account has not accepted this model's terms on its Hugging Face page, or the token cannot read it.")
      : site?.prefix === "civitai"
        ? (noKey ? "This model asks for a signed-in account: add a Civitai API key in Herramientas → Civitai." : "Civitai refused the API key for this download (it needs Read on Models).")
        : "This model needs a login or accepting its terms on the site.";
    return `Not downloaded: the server answered ${res.status}. ${fix} Otherwise the user can download it in the browser and put it in ${where.dir}.`;
  }
  if (!res.ok || !res.body) { void res.body?.cancel(); return `Not downloaded: the server answered HTTP ${res.status}.`; }
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type)) { void res.body.cancel(); return "Not downloaded: the address returned a web page, not a file. Use the file's direct download link (on Hugging Face, the one with /resolve/ in it; on Civitai, the one with /api/download/models/ in it)."; }
  if (!file) {
    file = nameFromAnswer(res, finalUrl);
    if (!file) { void res.body.cancel(); return `Not downloaded: ${NAME_HELP}, and this one is not.`; }
    try { const s = await stat(path.join(where.dir, file)); void res.body.cancel(); return `Already installed: ${path.join(where.dir, file)} (${human(s.size)}). Nothing was downloaded.`; } catch { /* not there: go on */ }
  }
  const dest = path.join(where.dir, file);
  const note = downloadNotePath(ctx?.uploadsDir, ctx?.agentId);
  const entry: DownloadEntry = { id: `${Date.now().toString(36)}-${file}`, url: url.toString(), file, dest, folder, state: "downloading", bytes: 0, total: null, startedAt: new Date().toISOString() };
  const part = `${dest}.part`;
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
  // The ComfyUI connection's own download refuses with a ComfyUI it treats as remote, and
  // any other install writes into comfy-cli's workspace, not the folder ComfyUI reads.
  supersedes: ["comfyui_download_model"],
  description:
    "Download a model file into the folder the user's ComfyUI reads for that kind of model, when a workflow needs a model that is not installed. " +
    "Use the file's direct link from the model's official page, never a guessed address (on Hugging Face the /resolve/ one, which huggingface_list_files gives; on Civitai the /api/download/models/<version> one, which civitai_model_info gives), and say its size to the user. " +
    "Gated Hugging Face models and Civitai models behind a sign-in download with the key the user stored in Herramientas; when one is missing, the answer says so. " +
    "Only .safetensors and .gguf, only https, never over an existing file, and only for a ComfyUI on this computer. The user approves every download. " +
    "It starts the download and returns: tell the user it is downloading and end; comfy_workflows action \"downloads\" shows the progress. Prefer this over the connection's download_model, which writes into comfy-cli's own folder.",
  schema: z.object({
    url: z.string().min(8).describe("The file's direct https download link."),
    folder: z.string().min(1).max(64).describe('The kind of model, as ComfyUI names its folders: "diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "clip_vision", "upscale_models"…'),
    filename: z.string().optional().describe("The file name to save it as, only when the link does not end in it."),
  }),
  execute: async ({ url, folder, filename }, ctx) => start(String(url), String(folder).trim(), filename, ctx),
};

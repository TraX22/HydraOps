import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import { comfyBaseUrl } from "../comfy_workflows/index.js";

// civitai — find and study models on Civitai: search, a model's versions with their files,
// trigger words and license, the example images with the settings that made them, and which
// model a file the user already has is. Civitai's public API only reads, so every tool here
// runs freely; downloading a file is comfy_download_model's job, with the user's approval.
//
// SECURITY: the API key is NEVER seen by the worker. Calls go to the local key-proxy under
// /civitai/…; the proxy adds `Authorization: Bearer <key>` when one is stored (it is optional:
// public models need none) and never follows a redirect. A key needs only Read on Models (and
// on Profile & Settings for the card to show the account). civitai.com and civitai.red answer
// the same API from the same service; only civitai.com is used.
//
// ADULT CONTENT is blocked unless the user allows it in Herramientas → Civitai. The setting
// lives in HydraOps' database and is read from the local API on every call: the agent cannot
// change it, there is no raw-API tool to go around it, and when the setting cannot be read
// the content stays blocked.

const MAX_OUTPUT = 200_000;
const SITE = "https://civitai.com";

function proxyBase(): string {
  return (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").trim().replace(/\/$/, "");
}
const apiUrl = () => (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

const cap = (s: string) => (s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + `\n\n[output truncated: ${s.length - MAX_OUTPUT} more characters]`);
const json = (v: unknown) => cap(JSON.stringify(v, null, 2));

/** Whether the user allowed adult content. Anything but a clear yes from the local API is no. */
export async function adultAllowed(): Promise<boolean> {
  try {
    const r = await fetch(`${apiUrl()}/api/system/integrations/civitai`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const d: any = await r.json();
    return d?.allowAdult === true;
  } catch { return false; }
}

const ADULT_BLOCKED = "This is marked as adult content on Civitai, which is blocked in HydraOps (Herramientas → Civitai).";

interface CvResult { ok: boolean; status: number; data?: any; error?: string }

async function cvGet(pathAndQuery: string): Promise<CvResult> {
  let target: URL;
  try { target = new URL(`${proxyBase()}/civitai${pathAndQuery}`); } catch { return { ok: false, status: 0, error: "That is not a valid Civitai request." }; }
  if (!target.pathname.startsWith("/civitai/api/")) return { ok: false, status: 0, error: "That request leaves Civitai's API; it is not made." };
  try {
    const res = await fetch(target, { headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(30000) });
    const noKey = res.headers.get("x-hydra-no-key") === "1";
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (res.ok) return { ok: true, status: res.status, data };
    if (res.status === 401) return { ok: false, status: 401, error: noKey ? "This needs a Civitai API key: add one in HydraOps → Herramientas → Civitai." : "Civitai did not accept the API key (401): it may have been deleted." };
    if (res.status === 404) return { ok: false, status: 404, error: "Not found on Civitai (404)." };
    if (res.status === 429) return { ok: false, status: 429, error: "Civitai rate limit reached. Try again later." };
    const msg = typeof data?.error === "string" ? `: ${data.error.slice(0, 200)}` : typeof data?.error?.message === "string" ? `: ${data.error.message.slice(0, 200)}` : "";
    return { ok: false, status: res.status, error: `Civitai request failed (HTTP ${res.status})${msg}` };
  } catch (e: any) {
    if (e?.name === "TimeoutError") return { ok: false, status: 0, error: "Civitai request timed out." };
    return { ok: false, status: 0, error: `Civitai request error: ${e?.message || e}` };
  }
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? "?" + parts.join("&") : "";
};
const sizeOf = (kb: unknown) => {
  const v = Number(kb) * 1024;
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : `${(v / 1e6).toFixed(1)} MB`;
};
// A model's description is HTML written by its author: shown as plain text, shortened.
const plain = (html: unknown, max = 1500) => {
  const t = String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const license = (m: any) => {
  const uses: string[] = Array.isArray(m?.allowCommercialUse) ? m.allowCommercialUse : typeof m?.allowCommercialUse === "string" ? [m.allowCommercialUse] : [];
  return {
    commercial_use: uses.length && !uses.includes("None") ? uses.join(", ") : "not allowed",
    credit_required: m?.allowNoCredit === false,
    derivatives_allowed: m?.allowDerivatives !== false,
    may_relicense: m?.allowDifferentLicense === true,
  };
};
const fileBrief = (f: any) => ({
  name: f?.name, kind: f?.type, format: f?.metadata?.format, precision: f?.metadata?.fp, size: sizeOf(f?.sizeKB),
  pickle_scan: f?.pickleScanResult, virus_scan: f?.virusScanResult, sha256: f?.hashes?.SHA256,
  // Only these formats load without running code; comfy_download_model takes no other.
  safe_format: /\.(safetensors|sft|gguf)$/i.test(String(f?.name ?? "")),
  download: f?.downloadUrl,
});
const versionBrief = (v: any) => ({
  version_id: v?.id, name: v?.name, base_model: v?.baseModel, published: v?.publishedAt,
  trigger_words: Array.isArray(v?.trainedWords) && v.trainedWords.length ? v.trainedWords : undefined,
  availability: v?.availability && v.availability !== "Public" ? v.availability : undefined,
  files: (Array.isArray(v?.files) ? v.files : []).map(fileBrief),
});

const TYPES = ["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "Hypernetwork", "Controlnet", "Upscaler", "VAE", "TextEncoder", "UNet", "CLIPVision", "MotionModule", "Poses", "Wildcards", "Workflows", "ComfyWorkflows", "Detection", "Other"] as const;
const SORTS = { most_downloaded: "Most Downloaded", highest_rated: "Highest Rated", most_liked: "Most Liked", newest: "Newest", hot: "Hot" } as const;

export const civitaiSearchTool: HydraTool = {
  name: "civitai_search",
  risk: { readsExternal: true },
  description: "Search Civitai for models: checkpoints, LoRAs, VAEs, ControlNets, upscalers, ComfyUI workflows… Filter by type, base model (e.g. \"Flux.1 D\", \"SDXL 1.0\", \"Pony\", \"Illustrious\") or creator, and sort by downloads, rating, likes, hot or newest. civitai_model_info gives a model's versions, files and trigger words.",
  schema: z.object({
    query: z.string().optional().describe("Words in the model's name."),
    type: z.enum(TYPES).optional(),
    base_model: z.string().max(60).optional().describe('As Civitai names it, e.g. "Flux.1 D", "SDXL 1.0", "Pony", "Illustrious", "Wan Video".'),
    creator: z.string().max(60).optional().describe("A creator's username."),
    sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).optional().describe("Default most_downloaded."),
    limit: z.number().int().min(1).max(30).optional().describe("Default 15."),
  }),
  execute: async ({ query, type, base_model, creator, sort, limit }) => {
    const adult = await adultAllowed();
    const r = await cvGet(`/api/v1/models${qs({
      query, types: type, baseModels: base_model, username: creator, limit: limit ?? 15,
      // Without the parameter Civitai leaves adult models out; allowed, they are asked for.
      sort: SORTS[(sort ?? "most_downloaded") as keyof typeof SORTS], nsfw: adult,
    })}`);
    if (!r.ok) return r.error as string;
    const items = (Array.isArray(r.data?.items) ? r.data.items : []).filter((m: any) => adult || !m.nsfw);
    if (!items.length) return "Nothing found on Civitai for that search.";
    return json(items.map((m: any) => ({
      model_id: m.id, name: m.name, type: m.type, creator: m.creator?.username,
      base_models: [...new Set((m.modelVersions ?? []).map((v: any) => v.baseModel).filter(Boolean))].slice(0, 5),
      latest_version_id: m.modelVersions?.[0]?.id, downloads: m.stats?.downloadCount, thumbs_up: m.stats?.thumbsUpCount,
      ...(adult ? { adult: !!m.nsfw } : {}), url: `${SITE}/models/${m.id}`,
    })));
  },
};

export const civitaiModelInfoTool: HydraTool = {
  name: "civitai_model_info",
  risk: { readsExternal: true },
  description: "A Civitai model's details: what it is, its license (commercial use, credit, derivatives), its description, and its versions with base model, trigger words (the words a LoRA needs in the prompt) and files (format, size, safety scans, SHA256 and download link). Give the model id, or a version id to see that version.",
  schema: z.object({
    model_id: z.number().int().positive().optional(),
    version_id: z.number().int().positive().optional().describe("A specific version; its model is shown with it."),
  }),
  execute: async ({ model_id, version_id }) => {
    if (!model_id && !version_id) return "Give a model_id or a version_id.";
    let id = model_id;
    if (!id) {
      const v = await cvGet(`/api/v1/model-versions/${version_id}`);
      if (!v.ok) return v.error as string;
      id = Number(v.data?.modelId);
      if (!id) return "Civitai did not say which model that version belongs to.";
    }
    const r = await cvGet(`/api/v1/models/${id}`);
    if (!r.ok) return r.error as string;
    const m = r.data ?? {};
    if (m.nsfw && !(await adultAllowed())) return ADULT_BLOCKED;
    const versions = (Array.isArray(m.modelVersions) ? m.modelVersions : []);
    const shown = version_id ? versions.filter((v: any) => v.id === version_id) : versions.slice(0, 8);
    // The model's answer leaves out each version's trigger words; the version's own has them.
    await Promise.all(shown.map(async (v: any) => {
      const d = await cvGet(`/api/v1/model-versions/${Number(v.id)}`);
      if (d.ok && Array.isArray(d.data?.trainedWords)) v.trainedWords = d.data.trainedWords;
    }));
    return json({
      model_id: m.id, name: m.name, type: m.type, creator: m.creator?.username, url: `${SITE}/models/${m.id}`,
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 15) : [], license: license(m),
      downloads: m.stats?.downloadCount, thumbs_up: m.stats?.thumbsUpCount,
      description: plain(m.description),
      versions: shown.map(versionBrief),
      ...(versions.length > shown.length && !version_id ? { more_versions: versions.length - shown.length } : {}),
    });
  },
};

export const civitaiExamplesTool: HydraTool = {
  name: "civitai_examples",
  risk: { readsExternal: true },
  description: "Example images people made with a Civitai model version, with the settings that made them: prompt, negative prompt, sampler, steps, CFG scale, seed and size. Use it to learn how a checkpoint or LoRA is prompted and tuned before building a workflow with it.",
  schema: z.object({
    version_id: z.number().int().positive(),
    limit: z.number().int().min(1).max(10).optional().describe("Default 5; only images that carry their settings are shown."),
    sort: z.enum(["most_reactions", "newest"]).optional().describe("Default most_reactions."),
  }),
  execute: async ({ version_id, limit, sort }) => {
    const adult = await adultAllowed();
    const r = await cvGet(`/api/v1/images${qs({
      modelVersionId: version_id, limit: 50, withMeta: true, sort: sort === "newest" ? "Newest" : "Most Reactions",
      ...(adult ? { nsfw: "X" } : {}),
    })}`);
    if (!r.ok) return r.error as string;
    const items = (Array.isArray(r.data?.items) ? r.data.items : [])
      .filter((i: any) => (adult || (i.nsfwLevel === "None" && !i.nsfw)) && i.meta && (i.meta.prompt || i.meta.Prompt));
    if (!items.length) return "No example images with their settings for that version.";
    const clip = (v: unknown, n: number) => (typeof v === "string" ? (v.length > n ? `${v.slice(0, n)}…` : v) : v);
    return json(items.slice(0, limit ?? 5).map((i: any) => {
      const m = i.meta ?? {};
      return {
        image: i.url, size: m.Size ?? (i.width && i.height ? `${i.width}x${i.height}` : undefined),
        prompt: clip(m.prompt ?? m.Prompt, 1500), negative: clip(m.negativePrompt, 800),
        sampler: m.sampler, scheduler: m.scheduler ?? m["Schedule type"], steps: m.steps, cfg_scale: m.cfgScale, seed: m.seed,
        other_resources: Array.isArray(m.resources) ? m.resources.slice(0, 6).map((x: any) => [x.type, x.name, x.weight].filter((y) => y !== undefined).join(" ")) : undefined,
        ...(adult ? { adult_level: i.nsfwLevel } : {}),
      };
    }));
  },
};

/** The folders the user's ComfyUI lists for a kind of model, on this computer. */
async function comfyFolders(base: string, folder: string): Promise<string[] | string> {
  let paths: Record<string, unknown>;
  try {
    const r = await fetch(`${base}/internal/folder_paths`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return `ComfyUI answered HTTP ${r.status} when asked for its model folders`;
    paths = (await r.json()) as Record<string, unknown>;
  } catch { return `ComfyUI did not answer at ${base}; it has to be running`; }
  const list = paths[folder];
  if (!Array.isArray(list)) return `ComfyUI has no model folder called "${folder}". Its folders: ${Object.keys(paths).filter((k) => Array.isArray(paths[k])).sort().join(", ")}`;
  return list.map(String).filter((d) => d && !d.includes("#"));
}

const isLoopback = (h: string) => /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(h);

export const civitaiIdentifyTool: HydraTool = {
  name: "civitai_identify",
  risk: { readsExternal: true },
  description: "Find out which Civitai model a model file the user already has in ComfyUI is (its name, version, base model, trigger words, license): the file's SHA256 is computed here and looked up on Civitai. Give the ComfyUI folder kind and the file name as ComfyUI lists it.",
  schema: z.object({
    folder: z.string().regex(/^[\w.-]{1,64}$/).describe('ComfyUI\'s folder kind, e.g. "loras", "checkpoints", "diffusion_models".'),
    file: z.string().min(1).max(260).describe('The file as ComfyUI lists it, e.g. "style/my_lora.safetensors".'),
  }),
  execute: async ({ folder, file }, ctx?: ToolContext) => {
    const base = comfyBaseUrl(ctx?.connectionEnv?.("comfyui")?.COMFYUI_URL || process.env.COMFYUI_URL);
    if (!isLoopback(new URL(base).hostname)) return `ComfyUI runs at ${base}, on another machine; its files cannot be read from here.`;
    const parts = String(file).split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some((p) => p === "." || p === "..")) return "That file name is not valid.";
    const dirs = await comfyFolders(base, folder);
    if (typeof dirs === "string") return dirs;
    let found: string | null = null;
    for (const d of dirs) {
      const root = await realpath(d).catch(() => "");
      if (!root) continue;
      const real = await realpath(path.join(root, ...parts)).catch(() => "");
      if (real && real.startsWith(root + path.sep) && (await stat(real).catch(() => null))?.isFile()) { found = real; break; }
    }
    if (!found) return `"${file}" is not in ComfyUI's "${folder}" folders.`;
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      createReadStream(found!).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject);
    });
    const sha = hash.digest("hex").toUpperCase();
    const r = await cvGet(`/api/v1/model-versions/by-hash/${sha}`);
    if (!r.ok) return r.status === 404 ? `Civitai does not know this file (SHA256 ${sha}): it may come from elsewhere (Hugging Face, a merge of your own) or have been removed.` : (r.error as string);
    const v = r.data ?? {};
    if (v.model?.nsfw && !(await adultAllowed())) return `${ADULT_BLOCKED} (The file is model ${v.modelId}.)`;
    return json({
      sha256: sha, model_id: v.modelId, model: v.model?.name, type: v.model?.type, version_id: v.id, version: v.name,
      base_model: v.baseModel, trigger_words: Array.isArray(v.trainedWords) && v.trainedWords.length ? v.trainedWords : undefined,
      url: `${SITE}/models/${v.modelId}?modelVersionId=${v.id}`,
    });
  },
};

export const civitaiTools: HydraTool[] = [civitaiSearchTool, civitaiModelInfoTool, civitaiExamplesTool, civitaiIdentifyTool];

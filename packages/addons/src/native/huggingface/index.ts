import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";

// huggingface — work with the Hugging Face Hub: find models, datasets and Spaces, read
// their cards and files, preview datasets, follow discussions; and, with the user's
// approval every time, create repositories, upload files and post in discussions.
//
// SECURITY: the access token is NEVER seen by the worker. Every call goes to the local
// key-proxy under /huggingface/… (the Hub) or /hfdatasets/… (the dataset viewer); the
// proxy adds `Authorization: Bearer <token>` when one is stored and goes out without it
// otherwise (public reads need none), and it never follows a redirect, so the token
// cannot reach another host. What a token may do is set on Hugging Face (read or write,
// fine-grained repos); a write it does not allow comes back as 403. The guard redacts
// hf_ token shapes from any output as a safety net.

const MAX_OUTPUT = 200_000;
const MAX_TEXT_FILE = 512 * 1024;
const MAX_UPLOAD_FILE = 10 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const MAX_LISTED_FILES = 500;
const HUB = "https://huggingface.co";

function proxyBase(): string {
  return (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").trim().replace(/\/$/, "");
}

function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n\n[output truncated: ${s.length - MAX_OUTPUT} more characters]`;
}

type RepoType = "model" | "dataset" | "space";
const apiPrefix = (t: RepoType) => `/api/${t}s`;
const webPrefix = (t: RepoType) => (t === "model" ? "" : `/${t}s`);
const repoType = z.enum(["model", "dataset", "space"]).optional().describe('What the repository holds (default "model").');

// "owner/name", or a bare legacy name such as "gpt2".
const REPO_RE = /^[\w.-]{1,96}(\/[\w.-]{1,96})?$/;
const validRepo = (id: string) => REPO_RE.test(id) && !id.split("/").some((p) => p === "." || p === "..");
// A path inside a repository, each segment encoded; no "..".
function repoPath(p: string): string | null {
  const parts = p.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((s) => s === "." || s === "..")) return null;
  return parts.map(encodeURIComponent).join("/");
}
const encRepo = (id: string) => id.split("/").map(encodeURIComponent).join("/");
const encRev = (rev?: string) => encodeURIComponent(rev?.trim() || "main");

interface HfResult { ok: boolean; status: number; data?: any; text?: string; error?: string; location?: string }

const NEEDS_TOKEN = "This needs a Hugging Face access token: add one in HydraOps → Herramientas → Hugging Face.";

/** One call through the key-proxy. `service` picks the Hub or the dataset viewer; `path` starts with "/". */
async function hfRequest(method: string, path: string, opts: { body?: string; contentType?: string; service?: "hub" | "datasets"; raw?: boolean } = {}): Promise<HfResult> {
  const prefix = opts.service === "datasets" ? "hfdatasets" : "huggingface";
  // The URL parser resolves dot segments, encoded ones (%2e%2e) included: a path that would
  // climb out of this prefix would reach another provider's route on the key-proxy, with
  // that provider's key. Checked on the address as fetch will send it.
  let target: URL;
  try { target = new URL(`${proxyBase()}/${prefix}${path}`); } catch { return { ok: false, status: 0, error: "That is not a valid Hugging Face path." }; }
  if (!target.pathname.startsWith(`/${prefix}/`)) return { ok: false, status: 0, error: "That path leaves Hugging Face; it is not requested." };
  try {
    const res = await fetch(target, {
      method,
      headers: { Accept: opts.raw ? "*/*" : "application/json", ...(opts.contentType ? { "Content-Type": opts.contentType } : {}) },
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    const noKey = res.headers.get("x-hydra-no-key") === "1";
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, location: res.headers.get("location") ?? undefined, error: `Hugging Face answered with a redirect (HTTP ${res.status}).` };
    }
    const text = await res.text();
    let data: any;
    if (!opts.raw) { try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; } }
    if (res.ok) return { ok: true, status: res.status, data, text };
    const apiMsg = typeof data?.error === "string" ? ` ${data.error.slice(0, 300)}` : "";
    if (res.status === 401) return { ok: false, status: 401, error: noKey ? `${NEEDS_TOKEN}${apiMsg}` : `Hugging Face did not accept the token (401): it may be expired or revoked.${apiMsg}` };
    if (res.status === 403) return { ok: false, status: 403, error: `Hugging Face denied this (403): the token's permissions do not allow it, or this is a gated repository whose terms the token's account has not accepted on its page.${apiMsg}` };
    if (res.status === 404) return { ok: false, status: 404, error: `Not found (404): it does not exist, or it is private and ${noKey ? "there is no token" : "the token cannot see it"}.${apiMsg}` };
    if (res.status === 429) return { ok: false, status: 429, error: "Hugging Face rate limit reached. Try again later." };
    return { ok: false, status: res.status, error: `Hugging Face request failed (HTTP ${res.status}).${apiMsg}` };
  } catch (e: any) {
    if (e?.name === "TimeoutError") return { ok: false, status: 0, error: "Hugging Face request timed out." };
    return { ok: false, status: 0, error: `Hugging Face request error: ${e?.message || e}` };
  }
}

/** A GET that follows a redirect inside the Hub (a renamed repository), through the proxy again. */
async function hubGet(path: string, raw = false): Promise<HfResult> {
  let r = await hfRequest("GET", path, { raw });
  for (let i = 0; i < 3 && r.location; i++) {
    const loc = r.location;
    if (loc.startsWith("/")) r = await hfRequest("GET", loc, { raw });
    else if (loc.startsWith(`${HUB}/`)) r = await hfRequest("GET", loc.slice(HUB.length), { raw });
    else return { ok: false, status: r.status, error: "Hugging Face sent this to another host; that address is not read through this tool." };
  }
  return r;
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? "?" + parts.join("&") : "";
};
const human = (n: unknown) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1e3))} KB`;
};
const licenseOf = (d: any): string | undefined =>
  d?.cardData?.license_name || d?.cardData?.license || (Array.isArray(d?.tags) ? d.tags.find((t: string) => t.startsWith("license:"))?.slice(8) : undefined);
const json = (v: unknown) => cap(JSON.stringify(v, null, 2));

// ── Reading ──

const SORTS: Record<string, string> = { downloads: "downloads", likes: "likes", trending: "trendingScore", updated: "lastModified" };

export const huggingfaceSearchTool: HydraTool = {
  name: "huggingface_search",
  risk: { readsExternal: true },
  description: "Search the Hugging Face Hub for models, datasets or Spaces. Filter by task (e.g. text-generation, text-to-image, image-to-3d), library (gguf, transformers, diffusers, mlx…) or author, and sort by downloads, likes, trending or last update. Says which ones are gated (ask for accepting terms).",
  schema: z.object({
    query: z.string().optional().describe("Words to search in the names."),
    type: repoType,
    task: z.string().optional().describe("Models only: the pipeline tag, e.g. text-generation."),
    library: z.string().optional().describe("Models only: e.g. gguf, transformers, diffusers."),
    author: z.string().optional().describe("A user or organization, e.g. Qwen."),
    sort: z.enum(["downloads", "likes", "trending", "updated"]).optional().describe("Default downloads."),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
  }),
  execute: async ({ query, type, task, library, author, sort, limit }) => {
    const t: RepoType = type ?? "model";
    const r = await hubGet(`${apiPrefix(t)}${qs({
      search: query, author, limit: limit ?? 20, sort: SORTS[sort ?? "downloads"], direction: -1,
      ...(t === "model" ? { pipeline_tag: task, library } : {}), full: t === "space" ? undefined : true,
    })}`);
    if (!r.ok) return r.error as string;
    const items = Array.isArray(r.data) ? r.data : [];
    if (!items.length) return "Nothing found on Hugging Face for that search.";
    return json(items.map((d: any) => ({
      id: d.id, ...(t === "model" ? { task: d.pipeline_tag, library: d.library_name } : {}),
      ...(t === "space" ? { sdk: d.sdk } : {}),
      downloads: d.downloads, likes: d.likes, gated: d.gated || false, license: licenseOf(d),
      updated: d.lastModified, url: `${HUB}${webPrefix(t)}/${d.id}`,
    })));
  },
};

export const huggingfaceRepoInfoTool: HydraTool = {
  name: "huggingface_repo_info",
  risk: { readsExternal: true },
  description: "Details of one model, dataset or Space on Hugging Face: task, library, license, size, base model, downloads, whether it is gated and whether the connected token has access to it. Read its README with huggingface_read_file and its files with huggingface_list_files.",
  schema: z.object({ repo: z.string().describe('The repository id, e.g. "Qwen/Qwen3-8B".'), type: repoType }),
  execute: async ({ repo, type }) => {
    if (!validRepo(repo)) return 'The repository id must look like "owner/name".';
    const t: RepoType = type ?? "model";
    const r = await hubGet(`${apiPrefix(t)}/${encRepo(repo)}`);
    if (!r.ok) return r.error as string;
    const d = r.data ?? {};
    const files = Array.isArray(d.siblings) ? d.siblings.map((s: any) => s.rfilename).filter(Boolean) : [];
    const out: any = {
      id: d.id, author: d.author, url: `${HUB}${webPrefix(t)}/${d.id}`,
      ...(t === "model" ? { task: d.pipeline_tag, library: d.library_name, parameters: d.safetensors?.total, base_model: d.cardData?.base_model } : {}),
      ...(t === "space" ? { sdk: d.sdk, state: d.runtime?.stage, hardware: d.runtime?.hardware?.current } : {}),
      license: licenseOf(d), gated: d.gated || false, private: d.private,
      downloads: d.downloads, likes: d.likes, updated: d.lastModified, storage: human(d.usedStorage),
      files: files.length, tags: Array.isArray(d.tags) ? d.tags.filter((x: string) => !x.startsWith("license:")).slice(0, 25) : [],
    };
    if (d.gated && files.length) {
      // A file's address answers with a redirect to the download when the token may read it.
      // The card, license and other text files stay public in a gated repository, so the
      // probe is a weights or data file.
      const probe = files.find((f: string) => /\.(safetensors|gguf|bin|pt|pth|ckpt|onnx|parquet|arrow|zip|tar|h5|msgpack)$/i.test(f))
        ?? files.find((f: string) => !/^\.git|(^|\/)(README|LICENSE)[^/]*$|\.(md|txt|json)$/i.test(f));
      const p = probe ? repoPath(probe) : null;
      const h = p ? await hfRequest("HEAD", `${webPrefix(t)}/${encRepo(repo)}/resolve/main/${p}`, { raw: true }) : null;
      out.access = !h ? "unknown"
        : h.ok || h.location ? "yes: the connected token can download its files"
        : h.status === 401 ? "no: gated, and there is no token or it is not valid"
        : h.status === 403 ? "no: the token's account has not accepted this repository's terms on its page (the user does that on Hugging Face)"
        : "unknown";
    }
    return json(out);
  },
};

export const huggingfaceListFilesTool: HydraTool = {
  name: "huggingface_list_files",
  risk: { readsExternal: true },
  description: "List the files of a Hugging Face repository (or of one folder in it), with their sizes and each file's direct download link. Useful to pick a quantization (e.g. which GGUF fits in memory) or to find the exact file a tool needs.",
  schema: z.object({
    repo: z.string(), type: repoType,
    path: z.string().optional().describe("A folder inside the repository; the whole repository when omitted."),
    revision: z.string().optional().describe("Branch, tag or commit; default main."),
  }),
  execute: async ({ repo, type, path: folder, revision }) => {
    if (!validRepo(repo)) return 'The repository id must look like "owner/name".';
    const t: RepoType = type ?? "model";
    const p = folder ? repoPath(folder) : "";
    if (p === null) return "That folder path is not valid.";
    const r = await hubGet(`${apiPrefix(t)}/${encRepo(repo)}/tree/${encRev(revision)}${p ? `/${p}` : ""}${qs({ recursive: true })}`);
    if (!r.ok) return r.error as string;
    const entries = (Array.isArray(r.data) ? r.data : []).filter((e: any) => e?.type === "file");
    if (!entries.length) return "No files there.";
    const listed = entries.slice(0, MAX_LISTED_FILES).map((e: any) => ({
      path: e.path, size: human(e.lfs?.size ?? e.size) ?? `${e.size ?? 0} bytes`,
      link: `${HUB}${webPrefix(t)}/${repo}/resolve/${revision?.trim() || "main"}/${e.path}`,
    }));
    const more = entries.length > listed.length ? `\n[${entries.length - listed.length} more files not listed; list a folder to see them]` : "";
    return json(listed) + more;
  },
};

export const huggingfaceReadFileTool: HydraTool = {
  name: "huggingface_read_file",
  risk: { readsExternal: true },
  description: "Read a text file of a Hugging Face repository: its README (the model or dataset card), config.json, a chat template, a license. Large and binary files (weights) are not read; huggingface_list_files gives their links.",
  schema: z.object({ repo: z.string(), type: repoType, path: z.string().describe("e.g. README.md or config.json"), revision: z.string().optional() }),
  execute: async ({ repo, type, path: file, revision }) => {
    if (!validRepo(repo)) return 'The repository id must look like "owner/name".';
    const p = repoPath(file);
    if (!p) return "That file path is not valid.";
    const t: RepoType = type ?? "model";
    const r = await hubGet(`${webPrefix(t)}/${encRepo(repo)}/raw/${encRev(revision)}/${p}`, true);
    if (!r.ok) return r.error as string;
    const text = r.text ?? "";
    if (text.startsWith("version https://git-lfs")) return `"${file}" is a large file stored outside the repository's text (weights or data), so it is not read here. huggingface_list_files gives its size and link.`;
    if (text.includes("\u0000")) return `"${file}" is a binary file; it is not read here.`;
    const body = text.length > MAX_TEXT_FILE ? `${text.slice(0, MAX_TEXT_FILE)}\n\n[file cut at ${MAX_TEXT_FILE} characters of ${text.length}]` : text;
    return cap(`// ${repo}/${file}\n\n${body}`);
  },
};

export const huggingfaceDatasetPreviewTool: HydraTool = {
  name: "huggingface_dataset_preview",
  risk: { readsExternal: true },
  description: "Preview a Hugging Face dataset without downloading it: its configurations and splits, its columns, and the first rows.",
  schema: z.object({
    dataset: z.string().describe('The dataset id, e.g. "stanfordnlp/imdb".'),
    config: z.string().optional().describe("Default: the first one."),
    split: z.string().optional().describe("Default: the first one (often train)."),
    rows: z.number().int().min(1).max(20).optional().describe("Default 5."),
  }),
  execute: async ({ dataset, config, split, rows }) => {
    if (!validRepo(dataset)) return 'The dataset id must look like "owner/name".';
    const s = await hfRequest("GET", `/splits${qs({ dataset })}`, { service: "datasets" });
    if (!s.ok) return s.error as string;
    const splits: { config: string; split: string }[] = Array.isArray(s.data?.splits) ? s.data.splits : [];
    if (!splits.length) return "The dataset viewer has no preview for this dataset.";
    const pick = splits.find((x) => (!config || x.config === config) && (!split || x.split === split));
    if (!pick) return `No such configuration/split. Available: ${splits.slice(0, 30).map((x) => `${x.config}/${x.split}`).join(", ")}`;
    const f = await hfRequest("GET", `/first-rows${qs({ dataset, config: pick.config, split: pick.split })}`, { service: "datasets" });
    if (!f.ok) return f.error as string;
    const clipCell = (v: unknown) => (typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v);
    const shown = (Array.isArray(f.data?.rows) ? f.data.rows : []).slice(0, rows ?? 5).map((r: any) =>
      Object.fromEntries(Object.entries(r.row ?? {}).map(([k, v]) => [k, clipCell(v)])));
    return json({
      dataset, config: pick.config, split: pick.split,
      available: splits.slice(0, 30).map((x) => `${x.config}/${x.split}`),
      columns: (Array.isArray(f.data?.features) ? f.data.features : []).map((c: any) => ({ name: c.name, type: c.type?.dtype ?? c.type?._type })),
      rows: shown,
    });
  },
};

export const huggingfaceDiscussionsTool: HydraTool = {
  name: "huggingface_discussions",
  risk: { readsExternal: true },
  description: "Read the discussions and pull requests of a Hugging Face repository: the list, or one of them with its comments.",
  schema: z.object({ repo: z.string(), type: repoType, number: z.number().int().min(1).optional().describe("One discussion, with its comments; the list when omitted.") }),
  execute: async ({ repo, type, number }) => {
    if (!validRepo(repo)) return 'The repository id must look like "owner/name".';
    const t: RepoType = type ?? "model";
    if (number) {
      const r = await hubGet(`${apiPrefix(t)}/${encRepo(repo)}/discussions/${number}`);
      if (!r.ok) return r.error as string;
      const d = r.data ?? {};
      return json({
        number: d.num, title: d.title, status: d.status, pull_request: d.isPullRequest, author: d.author?.name,
        url: `${HUB}${webPrefix(t)}/${repo}/discussions/${d.num}`,
        comments: (Array.isArray(d.events) ? d.events : []).filter((e: any) => e.type === "comment" && !e.data?.hidden)
          .map((e: any) => ({ author: e.author?.name, at: e.createdAt, text: String(e.data?.latest?.raw ?? "").slice(0, 4000) })),
      });
    }
    const r = await hubGet(`${apiPrefix(t)}/${encRepo(repo)}/discussions`);
    if (!r.ok) return r.error as string;
    const list = Array.isArray(r.data?.discussions) ? r.data.discussions : [];
    if (!list.length) return "This repository has no discussions.";
    return json(list.slice(0, 50).map((d: any) => ({ number: d.num, title: d.title, status: d.status, pull_request: d.isPullRequest, author: d.author?.name, comments: d.numComments })));
  },
};

export const huggingfaceWhoamiTool: HydraTool = {
  name: "huggingface_whoami",
  risk: { readsExternal: true },
  description: "Which Hugging Face account the connected token belongs to, its organizations, and what the token may do (read or write).",
  schema: z.object({}),
  execute: async () => {
    const r = await hfRequest("GET", "/api/whoami-v2");
    if (!r.ok) return r.error as string;
    const d = r.data ?? {};
    const tok = d.auth?.accessToken ?? {};
    return json({
      account: d.name, name: d.fullname, plan: d.isPro ? "PRO" : undefined,
      organizations: (Array.isArray(d.orgs) ? d.orgs : []).map((o: any) => o.name),
      token: { name: tok.displayName, role: tok.role, scoped: tok.role === "fineGrained" ? "fine-grained: its permissions are set per repository on Hugging Face" : undefined },
    });
  },
};

// ── Writing: every call waits for the user's approval ──

const WRITE = { sensitive: true, approval: "always" } as const;

export const huggingfaceCreateRepoTool: HydraTool = {
  name: "huggingface_create_repo",
  risk: WRITE,
  description: "Create a repository on Hugging Face (a model, a dataset or a Space), private unless the user asks otherwise. The user approves it. Needs a token with write permission.",
  schema: z.object({
    name: z.string().regex(/^[\w.-]{1,96}$/).describe("The repository's name, without the owner."),
    type: repoType,
    organization: z.string().regex(/^[\w.-]{1,96}$/).optional().describe("Create it under this organization instead of the user's account."),
    private: z.boolean().optional().describe("Default true."),
    space_sdk: z.enum(["gradio", "static", "docker"]).optional().describe("Spaces only (required for a Space)."),
  }),
  execute: async ({ name, type, organization, private: isPrivate, space_sdk }) => {
    const t: RepoType = type ?? "model";
    if (t === "space" && !space_sdk) return 'A Space needs "space_sdk" (gradio, static or docker).';
    const body = { type: t, name, ...(organization ? { organization } : {}), private: isPrivate !== false, ...(t === "space" ? { sdk: space_sdk } : {}) };
    const r = await hfRequest("POST", "/api/repos/create", { body: JSON.stringify(body), contentType: "application/json" });
    if (!r.ok) return r.error as string;
    return `Created ${isPrivate !== false ? "private " : "public "}${t} repository: ${r.data?.url ?? `${HUB}${webPrefix(t)}/${organization ?? "<account>"}/${name}`}`;
  },
};

/** A file this task wrote or the user attached, resolved inside those folders only. */
async function taskFile(ref: string, ctx?: ToolContext): Promise<{ path: string; size: number } | string> {
  const roots = [ctx?.filesDir, ctx?.uploadsDir].filter((d): d is string => !!d);
  if (!roots.length) return "this task has no files to upload";
  for (const root of roots) {
    const candidate = path.isAbsolute(ref) ? ref : path.join(root, ref);
    const real = await realpath(candidate).catch(() => "");
    const base = await realpath(root).catch(() => path.resolve(root));
    if (!real || (real !== base && !real.startsWith(base + path.sep))) continue;
    const st = await stat(real).catch(() => null);
    if (st?.isFile()) return { path: real, size: st.size };
  }
  return `"${path.basename(ref)}" is not a file of this task or one the user attached`;
}

export const huggingfaceUploadTool: HydraTool = {
  name: "huggingface_upload",
  risk: WRITE,
  description:
    "Upload files to a Hugging Face repository in one commit: files this task produced or the user attached, or text written here (a README, a config). Each file up to 10 MB; large weights are not uploaded by this tool. The user approves it. Needs a token with write permission on that repository.",
  schema: z.object({
    repo: z.string(), type: repoType,
    files: z.array(z.object({
      dest: z.string().describe("Where it goes in the repository, e.g. README.md or data/train.csv."),
      source: z.string().optional().describe("A file of this task or an attachment (its name or path)."),
      content: z.string().optional().describe("Or the text itself."),
    })).min(1).max(MAX_UPLOAD_FILES),
    message: z.string().min(1).max(300).describe("The commit message."),
    revision: z.string().optional().describe("Branch; default main."),
  }),
  execute: async ({ repo, type, files, message, revision }, ctx?: ToolContext) => {
    if (!validRepo(repo) || !repo.includes("/")) return 'The repository id must look like "owner/name".';
    const t: RepoType = type ?? "model";
    const lines: string[] = [JSON.stringify({ key: "header", value: { summary: message } })];
    const pre: { path: string; size: number; sample: string }[] = [];
    for (const f of files as { dest: string; source?: string; content?: string }[]) {
      const dest = repoPath(f.dest);
      if (!dest) return `"${f.dest}" is not a valid path in the repository.`;
      let bytes: Buffer;
      if (typeof f.content === "string" && !f.source) bytes = Buffer.from(f.content, "utf-8");
      else if (f.source) {
        const r = await taskFile(f.source, ctx);
        if (typeof r === "string") return `Not uploaded: ${r}.`;
        if (r.size > MAX_UPLOAD_FILE) return `Not uploaded: "${path.basename(r.path)}" is ${human(r.size)}; this tool uploads files up to 10 MB.`;
        bytes = await readFile(r.path);
      } else return `"${f.dest}" needs a "source" file or its "content".`;
      if (bytes.length > MAX_UPLOAD_FILE) return `Not uploaded: "${f.dest}" is over 10 MB.`;
      const plain = decodeURIComponent(dest);
      pre.push({ path: plain, size: bytes.length, sample: bytes.subarray(0, 512).toString("base64") });
      lines.push(JSON.stringify({ key: "file", value: { content: bytes.toString("base64"), path: plain, encoding: "base64" } }));
    }
    // The Hub decides per file whether it goes in the repository or in large-file storage;
    // only the first kind is uploaded here.
    const check = await hfRequest("POST", `${apiPrefix(t)}/${encRepo(repo)}/preupload/${encRev(revision)}`, { body: JSON.stringify({ files: pre }), contentType: "application/json" });
    if (!check.ok) return check.error as string;
    const large = (Array.isArray(check.data?.files) ? check.data.files : []).filter((x: any) => x.uploadMode === "lfs").map((x: any) => x.path);
    if (large.length) return `Not uploaded: Hugging Face keeps ${large.join(", ")} in large-file storage (binary or big files), which this tool does not upload yet. Nothing was committed.`;
    const r = await hfRequest("POST", `${apiPrefix(t)}/${encRepo(repo)}/commit/${encRev(revision)}`, { body: lines.join("\n"), contentType: "application/x-ndjson" });
    if (!r.ok) return r.error as string;
    return `Uploaded ${files.length} file(s) to ${repo} in one commit: ${r.data?.commitUrl ?? `${HUB}${webPrefix(t)}/${repo}`}`;
  },
};

export const huggingfaceDiscussTool: HydraTool = {
  name: "huggingface_discuss",
  risk: WRITE,
  description: "Post on a Hugging Face repository: open a new discussion (title and text), or comment on an existing discussion or pull request (its number). The user approves it.",
  schema: z.object({
    repo: z.string(), type: repoType,
    number: z.number().int().min(1).optional().describe("Comment on this discussion; omit to open a new one."),
    title: z.string().min(3).max(200).optional().describe("For a new discussion."),
    text: z.string().min(1).max(20000),
  }),
  execute: async ({ repo, type, number, title, text }) => {
    if (!validRepo(repo)) return 'The repository id must look like "owner/name".';
    const t: RepoType = type ?? "model";
    if (number) {
      const r = await hfRequest("POST", `${apiPrefix(t)}/${encRepo(repo)}/discussions/${number}/comment`, { body: JSON.stringify({ comment: text }), contentType: "application/json" });
      return r.ok ? `Comment posted: ${HUB}${webPrefix(t)}/${repo}/discussions/${number}` : (r.error as string);
    }
    if (!title) return 'A new discussion needs a "title".';
    const r = await hfRequest("POST", `${apiPrefix(t)}/${encRepo(repo)}/discussions`, { body: JSON.stringify({ title, description: text }), contentType: "application/json" });
    return r.ok ? `Discussion opened: ${HUB}${webPrefix(t)}/${repo}/discussions/${r.data?.num ?? ""}` : (r.error as string);
  },
};

export const huggingfaceApiTool: HydraTool = {
  name: "huggingface_api",
  // Reads with GET; any other method writes and waits for the user's approval.
  risk: (args: any) => (String(args?.method ?? "").toUpperCase() === "GET" ? { readsExternal: true } : { ...WRITE, readsExternal: true }),
  description: "Escape hatch: call any Hugging Face Hub API endpoint (paths under /api/) when no huggingface_* tool fits, e.g. GET /api/models/{id}/refs. Anything other than GET waits for the user's approval. The token's permissions still decide what is allowed.",
  schema: z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    path: z.string().describe("Starting with /api/, e.g. /api/models/Qwen/Qwen3-8B/refs"),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.record(z.string(), z.any()).optional().describe("JSON body for POST/PUT."),
  }),
  execute: async ({ method, path: p, query, body }) => {
    if (!/^\/api\/[\w./-]+$/.test(p) || p.split("/").some((s) => s === "." || s === "..")) return "The path must start with /api/ and contain only a plain path (no query; use \"query\").";
    const r = await hfRequest(method, `${p}${query ? qs(query as Record<string, string | number | boolean>) : ""}`, body ? { body: JSON.stringify(body), contentType: "application/json" } : {});
    if (!r.ok) return r.error as string;
    return r.data !== undefined ? json(r.data) : cap(r.text ?? "");
  },
};

export const huggingfaceTools: HydraTool[] = [
  huggingfaceSearchTool,
  huggingfaceRepoInfoTool,
  huggingfaceListFilesTool,
  huggingfaceReadFileTool,
  huggingfaceDatasetPreviewTool,
  huggingfaceDiscussionsTool,
  huggingfaceWhoamiTool,
  huggingfaceCreateRepoTool,
  huggingfaceUploadTool,
  huggingfaceDiscussTool,
  huggingfaceApiTool,
];

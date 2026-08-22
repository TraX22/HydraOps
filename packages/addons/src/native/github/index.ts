import { z } from "zod";
import { HydraTool } from "../../../types.js";

// github — work with a developer's GitHub through the official REST API.
//
// SECURITY: the fine-grained Personal Access Token is NEVER seen by the worker.
// Every call goes to the local key-proxy (KEY_PROXY_URL) under the /github/…
// prefix; the proxy injects `Authorization: Bearer <PAT>` from the key store at
// the network boundary. What the agent can actually do is governed by the PAT's
// scope on GitHub's side (read-only, specific repos, etc.), enforced by GitHub —
// so a write with a read-only token simply returns 403. The token is connected
// in Herramientas → GitHub. The guard additionally redacts GitHub token shapes
// from any tool output as a safety net.

const MAX_OUTPUT = 12000;
const UA = "HydraOps";

function proxyBase(): string {
  return (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").trim().replace(/\/$/, "");
}

function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n\n[output truncated: ${s.length - MAX_OUTPUT} more characters]`;
}

interface GhResult {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
}

// One call to the GitHub REST API through the key-proxy. `path` starts with "/".
async function ghRequest(method: string, path: string, body?: unknown): Promise<GhResult> {
  const url = `${proxyBase()}/github${path.startsWith("/") ? path : "/" + path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 401) {
      return { ok: false, status: 401, error: "GitHub is not connected. Add a Personal Access Token in HydraOps → Herramientas → GitHub." };
    }
    if (res.status === 403 || res.status === 404) {
      // 403 is usually a scope/permission problem (or rate limit); 404 can also be
      // a private resource the token can't see.
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 403 && remaining === "0") {
        return { ok: false, status: 403, error: "GitHub rate limit reached. Try again later." };
      }
      const detail = await res.text().catch(() => "");
      const msg = res.status === 403
        ? "GitHub denied this (403). Your token's scope may not allow this operation or repository — check its permissions."
        : "Not found (404) — the resource doesn't exist, or your token can't see it (private repo without access).";
      return { ok: false, status: res.status, error: `${msg}${detail ? " " + detail.slice(0, 200) : ""}` };
    }

    const text = await res.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const apiMsg = data?.message ? `: ${data.message}` : ` (HTTP ${res.status})`;
      return { ok: false, status: res.status, error: `GitHub request failed${apiMsg}` };
    }
    return { ok: true, status: res.status, data };
  } catch (e: any) {
    if (e?.name === "TimeoutError") return { ok: false, status: 0, error: "GitHub request timed out." };
    return { ok: false, status: 0, error: `GitHub request error: ${e?.message || e}` };
  }
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? "?" + parts.join("&") : "";
};

// Compact shapers — GitHub's raw JSON is huge; return only what a model needs.
const repoBrief = (r: any) => ({
  full_name: r.full_name, private: r.private, description: r.description || "",
  language: r.language || "", stars: r.stargazers_count, url: r.html_url,
  default_branch: r.default_branch,
});
const issueBrief = (i: any) => ({
  number: i.number, title: i.title, state: i.state, author: i.user?.login,
  labels: (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
  comments: i.comments, url: i.html_url,
});
const prBrief = (p: any) => ({
  number: p.number, title: p.title, state: p.state, author: p.user?.login,
  head: p.head?.ref, base: p.base?.ref, draft: p.draft, url: p.html_url,
});

const out = (r: GhResult, shape: (d: any) => unknown): string =>
  r.ok ? cap(JSON.stringify(shape(r.data), null, 2)) : (r.error as string);

// ── Tools ──

export const githubListReposTool: HydraTool = {
  name: "github_list_repos",
  description: "List GitHub repositories — the authenticated user's own repos, or a given user/org's public repos. Use before other repo operations to find the exact owner/name.",
  schema: z.object({
    owner: z.string().optional().describe("A user or org login to list their repos. Omit to list YOUR repositories."),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(),
    per_page: z.number().int().min(1).max(100).optional().describe("Max repos to return (default 30)."),
  }),
  execute: async ({ owner, sort, per_page }) => {
    const path = owner ? `/users/${owner}/repos` : "/user/repos";
    const r = await ghRequest("GET", `${path}${qs({ sort, per_page })}`);
    return out(r, (d) => (Array.isArray(d) ? d.map(repoBrief) : d));
  },
};

export const githubGetFileTool: HydraTool = {
  name: "github_get_file",
  description: "Read the contents of a file in a GitHub repository at a given path (optionally at a specific branch, tag, or commit).",
  schema: z.object({
    owner: z.string(), repo: z.string(), path: z.string().describe("File path within the repo, e.g. src/index.ts"),
    ref: z.string().optional().describe("Branch, tag or commit SHA. Defaults to the default branch."),
  }),
  execute: async ({ owner, repo, path, ref }) => {
    const r = await ghRequest("GET", `/repos/${owner}/${repo}/contents/${path}${qs({ ref })}`);
    if (!r.ok) return r.error as string;
    const d = r.data;
    if (d?.type !== "file" || typeof d.content !== "string") {
      return "That path is not a file (it may be a directory). List it with github_api if needed.";
    }
    const content = Buffer.from(d.content, d.encoding === "base64" ? "base64" : "utf-8").toString("utf-8");
    return cap(`// ${d.path} (${d.size} bytes)\n\n${content}`);
  },
};

export const githubListIssuesTool: HydraTool = {
  name: "github_list_issues",
  description: "List issues in a repository, with optional filters. Pull requests are excluded.",
  schema: z.object({
    owner: z.string(), repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: z.string().optional().describe("Comma-separated label names to filter by."),
    assignee: z.string().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  execute: async ({ owner, repo, state, labels, assignee, per_page }) => {
    const r = await ghRequest("GET", `/repos/${owner}/${repo}/issues${qs({ state, labels, assignee, per_page })}`);
    return out(r, (d) => (Array.isArray(d) ? d.filter((i: any) => !i.pull_request).map(issueBrief) : d));
  },
};

export const githubGetIssueTool: HydraTool = {
  name: "github_get_issue",
  description: "Get a single issue (or pull request) with its body and, optionally, its comments.",
  schema: z.object({
    owner: z.string(), repo: z.string(), number: z.number().int(),
    include_comments: z.boolean().optional().describe("Also fetch the comments (default false)."),
  }),
  execute: async ({ owner, repo, number, include_comments }) => {
    const r = await ghRequest("GET", `/repos/${owner}/${repo}/issues/${number}`);
    if (!r.ok) return r.error as string;
    const base: any = { ...issueBrief(r.data), body: r.data.body || "" };
    if (include_comments) {
      const c = await ghRequest("GET", `/repos/${owner}/${repo}/issues/${number}/comments${qs({ per_page: 100 })}`);
      base.comment_list = c.ok && Array.isArray(c.data)
        ? c.data.map((x: any) => ({ author: x.user?.login, body: x.body }))
        : [];
    }
    return cap(JSON.stringify(base, null, 2));
  },
};

export const githubCreateIssueTool: HydraTool = {
  name: "github_create_issue",
  description: "Open a new issue in a repository. Requires a token whose scope allows writing issues on that repo.",
  schema: z.object({
    owner: z.string(), repo: z.string(), title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  execute: async ({ owner, repo, title, body, labels }) => {
    const r = await ghRequest("POST", `/repos/${owner}/${repo}/issues`, { title, body, labels });
    return r.ok ? `Created issue #${r.data.number}: ${r.data.html_url}` : (r.error as string);
  },
};

export const githubCommentTool: HydraTool = {
  name: "github_comment",
  description: "Add a comment to an issue OR a pull request (PRs are issues on GitHub, so use the PR number here). Needs write scope.",
  schema: z.object({
    owner: z.string(), repo: z.string(), number: z.number().int().describe("Issue or PR number."),
    body: z.string(),
  }),
  execute: async ({ owner, repo, number, body }) => {
    const r = await ghRequest("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
    return r.ok ? `Comment posted: ${r.data.html_url}` : (r.error as string);
  },
};

export const githubListPullsTool: HydraTool = {
  name: "github_list_pulls",
  description: "List pull requests in a repository.",
  schema: z.object({
    owner: z.string(), repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  execute: async ({ owner, repo, state, per_page }) => {
    const r = await ghRequest("GET", `/repos/${owner}/${repo}/pulls${qs({ state, per_page })}`);
    return out(r, (d) => (Array.isArray(d) ? d.map(prBrief) : d));
  },
};

export const githubGetPullTool: HydraTool = {
  name: "github_get_pull",
  description: "Get a pull request with its description and, optionally, the list of changed files.",
  schema: z.object({
    owner: z.string(), repo: z.string(), number: z.number().int(),
    include_files: z.boolean().optional().describe("Also list changed files with additions/deletions (default false)."),
  }),
  execute: async ({ owner, repo, number, include_files }) => {
    const r = await ghRequest("GET", `/repos/${owner}/${repo}/pulls/${number}`);
    if (!r.ok) return r.error as string;
    const base: any = { ...prBrief(r.data), body: r.data.body || "", additions: r.data.additions, deletions: r.data.deletions, changed_files: r.data.changed_files };
    if (include_files) {
      const f = await ghRequest("GET", `/repos/${owner}/${repo}/pulls/${number}/files${qs({ per_page: 100 })}`);
      base.files = f.ok && Array.isArray(f.data)
        ? f.data.map((x: any) => ({ filename: x.filename, status: x.status, additions: x.additions, deletions: x.deletions }))
        : [];
    }
    return cap(JSON.stringify(base, null, 2));
  },
};

export const githubSearchTool: HydraTool = {
  name: "github_search",
  description: "Search GitHub for repositories, code, or issues/PRs using GitHub's search syntax (e.g. 'repo:owner/name path:src useState').",
  schema: z.object({
    query: z.string().describe("GitHub search query."),
    type: z.enum(["repositories", "code", "issues"]).optional().describe("What to search (default repositories)."),
    per_page: z.number().int().min(1).max(50).optional(),
  }),
  execute: async ({ query, type, per_page }) => {
    const kind = type || "repositories";
    const r = await ghRequest("GET", `/search/${kind}${qs({ q: query, per_page })}`);
    if (!r.ok) return r.error as string;
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    const shaped = items.map((it: any) => {
      if (kind === "repositories") return repoBrief(it);
      if (kind === "code") return { repo: it.repository?.full_name, path: it.path, url: it.html_url };
      return issueBrief(it);
    });
    return cap(JSON.stringify({ total: r.data?.total_count, items: shaped }, null, 2));
  },
};

export const githubApiTool: HydraTool = {
  name: "github_api",
  description: "Escape hatch: call ANY GitHub REST API endpoint directly when no curated github_* tool fits. Provide the method and path (e.g. GET /repos/{owner}/{repo}/branches). The token's scope still governs what's allowed.",
  schema: z.object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method."),
    path: z.string().describe("API path starting with '/', e.g. /repos/owner/name/commits"),
    query: z.record(z.union([z.string(), z.number()])).optional().describe("Optional query parameters."),
    body: z.record(z.any()).optional().describe("Optional JSON body for POST/PATCH/PUT."),
  }),
  execute: async ({ method, path, query, body }) => {
    const q = query ? qs(query as Record<string, string | number>) : "";
    const r = await ghRequest(method, `${path}${q}`, body);
    return r.ok ? cap(JSON.stringify(r.data, null, 2)) : (r.error as string);
  },
};

export const githubTools: HydraTool[] = [
  githubListReposTool,
  githubGetFileTool,
  githubListIssuesTool,
  githubGetIssueTool,
  githubCreateIssueTool,
  githubCommentTool,
  githubListPullsTool,
  githubGetPullTool,
  githubSearchTool,
  githubApiTool,
];

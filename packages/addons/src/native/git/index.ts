import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { HydraTool } from "../../types.js";
import {
  NO_GIT, runGit, gitFail, resolveDir, repoTop, remoteTarget, currentBranch, validBranch, parseGithubRemote, githubUrl,
  viaProxy, githubConnected, shownUrl, isEmptyDir, asGitHub, type GitRun,
} from "./core.js";

// git_read / git_write / git_sync — the Git that is installed on this computer, for the
// agents, inside the folders the user allowed in Tools → Git and nowhere else.
//
// They are their own tools, apart from the github_* ones (GitHub's API): an agent may have
// either without the other. Whatever goes wrong (Git not installed, no folder allowed, a
// remote that is not GitHub, no token) comes back as a sentence the agent can act on, never
// as an exception, so the task goes on.
//
// What each one may do:
//  - git_read looks, and changes nothing. What it returns (commit messages, file contents,
//    names) may have been written by someone else, so it comes back as outside content.
//  - git_write changes the local repository only, and never rewrites history: there is no
//    amend, no reset --hard, no rebase, no forced anything.
//  - git_sync talks to the repository's GitHub remote through the key-proxy (see core.ts).
//    A push waits for the user's approval every time, whatever the task read and whatever
//    the security mode: it is the step that leaves the computer.

const MAX_OUTPUT = 200_000;
const MAX_LINES = 400;
const WRITE_TIMEOUT = 10 * 60_000;
const NETWORK_TIMEOUT = 30 * 60_000;

const apiUrl = () => (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

/** The folders the user allowed, asked from the local API on every call. Anything but a clear answer is none. */
async function allowedFolders(): Promise<string[]> {
  try {
    const r = await fetch(`${apiUrl()}/api/system/integrations/git`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const d: any = await r.json();
    return Array.isArray(d?.folders) ? d.folders.filter((f: unknown) => typeof f === "string") : [];
  } catch { return []; }
}

const cap = (s: string) => (s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + `\n\n[output cut: ${s.length - MAX_OUTPUT} more characters]`);
/** Git's output as the agent gets it: no colour codes, no progress lines, the key-proxy's address read back as GitHub's. */
function tidy(s: string, maxLines = MAX_LINES): string {
  const lines = asGitHub(s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))
    .split(/\r?\n/).map((l) => l.split("\r").pop() ?? "").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines.length <= maxLines) return cap(lines.join("\n"));
  return cap(lines.slice(0, maxLines).join("\n") + `\n… ${lines.length - maxLines} more lines`);
}
const both = (r: GitRun) => tidy([r.out.trim(), r.err.trim()].filter(Boolean).join("\n"));

/** A revision or a range (main, HEAD~2, v1.0..main): nothing Git could read as an option or a path. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./@^~{}-]*$/;
const refOf = (v: unknown): string | null | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return undefined;
  return REF.test(s) && s.length <= 200 ? s : null;
};

/** Paths inside the repository, as given: each one is taken literally, and none may leave it. */
function pathsOf(v: unknown): string[] | { error: string } {
  const list = (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : []).map((p) => String(p).trim()).filter(Boolean);
  for (const p of list) {
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..") || p.startsWith(":")) {
      return { error: `"${p}" is not a path inside the repository (give it relative to the repository's folder).` };
    }
  }
  return list.slice(0, 200);
}

/** The repository a call works in: the allowed folder it names, and the top of the repository it belongs to. */
async function open(repo: unknown): Promise<{ dir: string; folders: string[] } | { error: string }> {
  const folders = await allowedFolders();
  const where = await resolveDir(repo, folders);
  if ("error" in where) return where;
  const top = await repoTop(where.dir, folders);
  if ("error" in top) return top;
  return { dir: top.top, folders };
}

const repoParam = z.string().optional().describe("The repository's folder (a path inside one the user allowed in Tools → Git). Leave it out when a single folder is allowed.");

// ── git_read ──────────────────────────────────────────────────────────────────

export const gitReadTool: HydraTool = {
  name: "git_read",
  title: "Git: look",
  // Reads only. Commit messages and file contents may come from other people.
  risk: { readsExternal: true },
  description:
    "Look at a Git repository in a folder the user allowed (Tools → Git), changing nothing. Actions: \"status\" (the branch, what changed, how far ahead or behind its remote), \"log\" (recent commits), \"diff\" (the changes not committed yet; `staged` for what is staged, `ref` for another revision or a range like main..feature, `stat` for the summary only), \"show\" (one commit), \"branches\", \"remotes\".",
  schema: z.object({
    action: z.enum(["status", "log", "diff", "show", "branches", "remotes"]),
    repo: repoParam,
    ref: z.string().optional().describe("log, diff, show: a branch, tag, commit or range (e.g. main, HEAD~1, main..feature). show defaults to the last commit."),
    path: z.string().optional().describe("log, diff: only this file or folder of the repository."),
    staged: z.boolean().optional().describe("diff: what is staged for the next commit."),
    stat: z.boolean().optional().describe("diff, show: only the list of files and how much each changed (a long diff costs a lot)."),
    limit: z.number().int().min(1).max(100).optional().describe("log: how many commits (default 15)."),
  }),
  execute: async ({ action, repo, ref, path: p, staged, stat, limit }) => {
    try {
      const at = await open(repo);
      if ("error" in at) return at.error;
      const dir = at.dir;
      const r0 = refOf(ref);
      if (r0 === null) return `"${ref}" is not a revision Git can read here (a branch, a tag, a commit, or a range like main..feature).`;
      const only = pathsOf(p);
      if ("error" in only) return only.error;
      const tail = only.length ? ["--", ...only] : [];
      const lit = ["--literal-pathspecs"];

      if (action === "status") {
        const r = await runGit(dir, ["status", "--short", "--branch"], { config: ["-c", "status.relativePaths=false"] });
        if (r.code !== 0) return gitFail(r);
        const lines = r.out.split(/\r?\n/).filter(Boolean);
        return `Repository: ${dir}\n${tidy(r.out)}${lines.length <= 1 ? "\nNothing to commit: the working folder is clean." : ""}`;
      }
      if (action === "log") {
        const r = await runGit(dir, [...lit, "log", `-n${limit ?? 15}`, "--date=short", "--pretty=format:%h %ad %an: %s%d", ...(r0 ? ["--end-of-options", r0] : []), ...tail]);
        if (r.code !== 0) return /does not have any commits yet/i.test(r.err) ? "This repository has no commits yet." : gitFail(r);
        return tidy(r.out) || "No commits match.";
      }
      if (action === "diff") {
        const r = await runGit(dir, [...lit, "diff", "--no-ext-diff", "--no-textconv", ...(stat ? ["--stat"] : []), ...(staged ? ["--cached"] : []), ...(r0 ? ["--end-of-options", r0] : []), ...tail]);
        if (r.code !== 0) return gitFail(r);
        return tidy(r.out, 4000) || (staged ? "Nothing is staged." : "No changes to show (new files that Git does not follow yet appear in \"status\", not here).");
      }
      if (action === "show") {
        const r = await runGit(dir, ["show", "--no-ext-diff", "--no-textconv", "--date=short", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B", "--stat", ...(stat ? [] : ["--patch"]), "--end-of-options", r0 ?? "HEAD"]);
        if (r.code !== 0) return gitFail(r);
        return tidy(r.out, 4000);
      }
      if (action === "branches") {
        const r = await runGit(dir, ["branch", "--all", "--format=%(HEAD) %(refname:short)%(if)%(upstream:short)%(then) → %(upstream:short) %(upstream:track)%(end)"]);
        if (r.code !== 0) return gitFail(r);
        return tidy(r.out) || "No branches yet (the repository has no commits).";
      }
      const r = await runGit(dir, ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]);
      if (r.missing) return NO_GIT;
      const lines = r.out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [key, ...rest] = l.split(" ");
        return `${key.replace(/^remote\./, "").replace(/\.url$/, "").replace(/\.pushurl$/, " (push)")}: ${shownUrl(rest.join(" "))}`;
      });
      return lines.length ? lines.join("\n") : "This repository has no remote. git_write with action \"set_remote\" adds one (a GitHub address).";
    } catch (e: any) {
      return `Git could not be run: ${e?.message || e}`;
    }
  },
};

// ── git_write ─────────────────────────────────────────────────────────────────

const IDENTITY = "Git has no author name and e-mail for commits on this computer. The user sets them once, in a terminal: git config --global user.name \"Their Name\" and git config --global user.email \"their@address\". Nothing was committed.";

export const gitWriteTool: HydraTool = {
  name: "git_write",
  title: "Git: change",
  // Changes files Git keeps on this computer; what it answers is Git's own report.
  risk: { sensitive: true },
  description:
    "Change a local Git repository in a folder the user allowed (Tools → Git). Actions: \"commit\" (give `message`; with `all: true` every change is staged first, with `paths` only those, so staging needs no call of its own), \"stage\", \"unstage\", \"branch\" (create one and switch to it), \"switch\" (to an existing branch), \"init\" (make the folder a repository), \"set_remote\" (the repository's GitHub address). Nothing leaves this computer: sending commits to GitHub is git_sync. History is never rewritten (no amend, no reset, no rebase).",
  schema: z.object({
    action: z.enum(["commit", "stage", "unstage", "branch", "switch", "init", "set_remote"]),
    repo: repoParam,
    message: z.string().optional().describe("commit: the commit message (a short first line; details after an empty line)."),
    all: z.boolean().optional().describe("commit, stage, unstage: every change in the repository."),
    paths: z.array(z.string()).optional().describe("commit, stage, unstage: these files or folders, relative to the repository."),
    name: z.string().optional().describe("branch, switch: the branch. set_remote: the remote's name (default origin)."),
    url: z.string().optional().describe("set_remote: the GitHub repository, e.g. https://github.com/owner/name"),
  }),
  execute: async ({ action, repo, message, all, paths, name, url }) => {
    try {
      if (action === "init") {
        const folders = await allowedFolders();
        const where = await resolveDir(repo, folders, true);
        if ("error" in where) return where.error;
        await mkdir(where.dir, { recursive: true });
        const inside = await runGit(where.dir, ["rev-parse", "--show-toplevel"]);
        if (inside.missing) return NO_GIT;
        if (inside.code === 0) return `"${where.dir}" is already inside a Git repository (${inside.out.trim()}).`;
        const r = await runGit(where.dir, ["init", "--initial-branch=main"]);
        return r.code === 0 ? `"${where.dir}" is now a Git repository, on the branch main, with no commits yet.` : gitFail(r);
      }
      const at = await open(repo);
      if ("error" in at) return at.error;
      const dir = at.dir;
      const list = pathsOf(paths);
      if ("error" in list) return list.error;
      const lit = ["--literal-pathspecs"];
      const shortStatus = async () => tidy((await runGit(dir, ["status", "--short", "--branch"])).out, 60);

      if (action === "stage" || action === "unstage") {
        if (!all && !list.length) return `${action} needs \`paths\`, or \`all: true\`.`;
        const r = action === "stage"
          ? await runGit(dir, [...lit, "add", ...(all ? ["--all"] : ["--", ...list])], { timeoutMs: WRITE_TIMEOUT })
          : await runGit(dir, [...lit, "restore", "--staged", "--", ...(all ? ["."] : list)], { timeoutMs: WRITE_TIMEOUT });
        if (r.code !== 0) return gitFail(r);
        return `${action === "stage" ? "Staged" : "Unstaged"}. Now:\n${await shortStatus()}`;
      }
      if (action === "commit") {
        const msg = typeof message === "string" ? message.trim() : "";
        if (!msg) return "commit needs `message`.";
        if (msg.length > 8000) return "The commit message is too long (8,000 characters at most).";
        if (all || list.length) {
          const add = await runGit(dir, [...lit, "add", ...(all ? ["--all"] : ["--", ...list])], { timeoutMs: WRITE_TIMEOUT });
          if (add.code !== 0) return gitFail(add);
        }
        const r = await runGit(dir, ["commit", "--quiet", "-m", msg], { timeoutMs: WRITE_TIMEOUT });
        if (r.code !== 0) {
          const said = `${r.out}\n${r.err}`;
          if (/tell me who you are|empty ident|unable to auto-detect email/i.test(said)) return IDENTITY;
          if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(said)) {
            return `Nothing was committed: nothing is staged${all ? " and there are no changes" : ""}. Stage changes with \`all: true\` or \`paths\`. Now:\n${await shortStatus()}`;
          }
          return gitFail(r);
        }
        const made = await runGit(dir, ["show", "--stat", "--date=short", "--format=%h %s (%an, %ad)", "HEAD"]);
        return `Committed on ${(await currentBranch(dir)) ?? "a detached HEAD"}:\n${tidy(made.out, 40)}\nIt is on this computer only; git_sync with action "push" sends it to GitHub (that always waits for the user's approval).`;
      }
      if (action === "branch" || action === "switch") {
        if (!(await validBranch(dir, name))) return `"${name ?? ""}" is not a branch name Git accepts.`;
        const b = String(name).trim();
        const r = await runGit(dir, action === "branch" ? ["switch", "--create", b] : ["switch", b], { timeoutMs: WRITE_TIMEOUT });
        if (r.code !== 0) return gitFail(r);
        return `${action === "branch" ? "Created the branch" : "Now on"} ${b}.\n${await shortStatus()}`;
      }
      // set_remote
      const g = parseGithubRemote(String(url ?? ""));
      if (!g) return "set_remote needs `url`: a repository on github.com, e.g. https://github.com/owner/name. This tool only works with GitHub remotes.";
      const remote = typeof name === "string" && name.trim() ? name.trim() : "origin";
      if (!/^[A-Za-z0-9][\w.-]*$/.test(remote)) return `"${remote}" is not a remote's name.`;
      const has = (await runGit(dir, ["config", "--get", `remote.${remote}.url`])).code === 0;
      const r = await runGit(dir, has ? ["remote", "set-url", remote, githubUrl(g)] : ["remote", "add", remote, githubUrl(g)]);
      return r.code === 0 ? `The remote ${remote} is ${githubUrl(g)}.` : gitFail(r);
    } catch (e: any) {
      return `Git could not be run: ${e?.message || e}`;
    }
  },
};

// ── git_sync ──────────────────────────────────────────────────────────────────

const NO_TOKEN = "GitHub is not connected: no token is stored in HydraOps. The user adds one in Tools → GitHub (to push it needs write access to the repository's contents).";

/** What went wrong with GitHub, in words the agent can pass on. Null when Git's own message is the best there is. */
function networkProblem(r: GitRun, pushing: boolean): string | null {
  const said = `${r.out}\n${r.err}`;
  if (/returned error: 403|Permission to .* denied|Write access to repository not granted/i.test(said)) {
    return `GitHub refused (403): the token stored in HydraOps may not ${pushing ? "write to" : "read"} this repository. The user gives it ${pushing ? "\"Contents: Read and write\" on" : "access to"} this repository on GitHub (Settings → Developer settings → Personal access tokens), or stores another one in Tools → GitHub.`;
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|returned error: 401|No API key stored/i.test(said)) {
    return "GitHub did not accept the token stored in HydraOps (missing, expired or revoked). The user checks it in Tools → GitHub.";
  }
  if (/Repository not found|repository '.*' not found|returned error: 404/i.test(said)) {
    return "GitHub answered that the repository does not exist, or the token stored in HydraOps cannot see it (a private repository it was not given).";
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(said)) {
    return "GitHub has commits this branch does not have, so the push was refused and nothing was overwritten. Bring them in first (git_sync with action \"pull\"), then push again.";
  }
  if (/Not possible to fast-forward|Need to specify how to reconcile|divergent branches/i.test(said)) {
    return "The branch here and the one on GitHub have each moved on, so a plain pull cannot join them and nothing was changed. Joining them needs a merge, which this tool does not do: tell the user.";
  }
  if (/returned error: 502|Failed to connect|Could not resolve host|Connection refused|Connection timed out/i.test(said)) {
    return "GitHub could not be reached (no connection, or HydraOps' key-proxy is not running).";
  }
  return null;
}

export const gitSyncTool: HydraTool = {
  name: "git_sync",
  title: "Git: GitHub",
  // A push always asks. A fetch only brings commits in; a pull or a clone also writes files.
  // With no arguments (the tool lists) it answers for its riskiest call.
  risk: (args: any) => (args?.action === "fetch" ? { readsExternal: true }
    : args?.action === "pull" || args?.action === "clone" ? { readsExternal: true, sensitive: true }
    : { sensitive: true, approval: "always" }),
  description:
    "Exchange commits between a repository in a folder the user allowed (Tools → Git) and its remote on GitHub, with the GitHub token stored in HydraOps (you never see it or need it). Actions: \"push\" (sends the current branch, or `branch`; it ALWAYS waits for the user's approval, so call it once, say what it will send, and do not retry; it is never forced), \"fetch\", \"pull\" (only when it is a fast-forward: no merge), \"clone\" (a GitHub repository `url` into `into`, a new folder inside an allowed one). Only remotes on github.com.",
  schema: z.object({
    action: z.enum(["push", "fetch", "pull", "clone"]),
    repo: repoParam,
    remote: z.string().optional().describe("push, fetch, pull: the remote's name (default origin)."),
    branch: z.string().optional().describe("push, pull: the branch (default: the one checked out)."),
    url: z.string().optional().describe("clone: the GitHub repository, e.g. https://github.com/owner/name"),
    into: z.string().optional().describe("clone: the new folder for it, inside an allowed folder (default: the repository's name inside the allowed folder)."),
  }),
  execute: async ({ action, repo, remote, branch, url, into }) => {
    try {
      if (action === "clone") {
        const g = parseGithubRemote(String(url ?? ""));
        if (!g) return "clone needs `url`: a repository on github.com, e.g. https://github.com/owner/name. This tool only works with GitHub.";
        const folders = await allowedFolders();
        const base = await resolveDir(typeof into === "string" && into.trim() ? into : repo, folders, true);
        if ("error" in base) return base.error;
        const dest = typeof into === "string" && into.trim() ? base.dir : path.join(base.dir, g.repo);
        if (!(await isEmptyDir(dest))) return `"${dest}" already exists and is not empty. Give another folder with \`into\`.`;
        const parent = path.dirname(dest);
        await mkdir(parent, { recursive: true });
        const r = await runGit(parent, ["clone", "--end-of-options", githubUrl(g), dest], { config: viaProxy(githubUrl(g), g), timeoutMs: NETWORK_TIMEOUT });
        if (r.code !== 0) return networkProblem(r, false) ?? gitFail(r);
        return `Cloned ${g.owner}/${g.repo} into "${dest}".\n${both(r)}`;
      }

      const at = await open(repo);
      if ("error" in at) return at.error;
      const dir = at.dir;
      let b: string | null = null;
      if (typeof branch === "string" && branch.trim()) {
        if (!(await validBranch(dir, branch))) return `"${branch}" is not a branch name Git accepts.`;
        b = branch.trim();
      }
      const target = await remoteTarget(dir, remote);
      if ("error" in target) return target.error;
      const where = `${target.github.owner}/${target.github.repo} (${target.remote})`;

      if (action === "fetch") {
        const r = await runGit(dir, ["fetch", target.remote], { config: target.config, timeoutMs: NETWORK_TIMEOUT });
        if (r.code !== 0) return networkProblem(r, false) ?? gitFail(r);
        return `Fetched from ${where}.\n${both(r) || "Nothing new."}`;
      }
      if (action === "pull") {
        const r = await runGit(dir, ["pull", "--ff-only", "--no-rebase", ...(b ? [target.remote, b] : [])], { config: target.config, timeoutMs: NETWORK_TIMEOUT });
        if (r.code !== 0) return networkProblem(r, false) ?? gitFail(r);
        return `Pulled from ${where}.\n${both(r)}`;
      }
      // push
      b ??= await currentBranch(dir);
      if (!b) return "No branch is checked out here (a detached HEAD), so there is nothing to push. Say which with `branch`.";
      if ((await runGit(dir, ["rev-parse", "--verify", "-q", `refs/heads/${b}`])).code !== 0) return `There is no branch "${b}" here (a repository with no commits has none yet).`;
      if (!(await githubConnected())) return NO_TOKEN;
      const tracked = (await runGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${b}@{upstream}`])).code === 0;
      const r = await runGit(dir, ["push", ...(tracked ? [] : ["--set-upstream"]), target.remote, `refs/heads/${b}:refs/heads/${b}`], { config: target.config, timeoutMs: NETWORK_TIMEOUT });
      if (r.code !== 0) return networkProblem(r, true) ?? gitFail(r);
      return `Pushed ${b} to ${where}.\n${both(r)}`;
    } catch (e: any) {
      return `Git could not be run: ${e?.message || e}`;
    }
  },
};

export const gitTools: HydraTool[] = [gitReadTool, gitWriteTool, gitSyncTool];
export { pushPreview, checkGitFolder, gitVersions, type PushPreview } from "./core.js";

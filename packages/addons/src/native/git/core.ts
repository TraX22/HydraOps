import { execFile } from "node:child_process";
import { realpath, stat, readdir } from "node:fs/promises";
import path from "node:path";

// What the git tools share: running the Git that is installed on this computer, the folders
// the user allowed, and how a GitHub remote is reached.
//
// Git is run directly with a fixed list of arguments, never through a shell, so nothing an
// agent writes (a branch name, a path, a message) is ever read as a command.
//
// SECURITY: the worker never holds a GitHub credential. A fetch, pull, push or clone is
// pointed at the local key-proxy (KEY_PROXY_URL) for that one command, with a rewrite rule
// given on the command line, and the proxy adds the token stored in HydraOps at the network
// boundary. Nothing about it is written to the repository's configuration, and the
// credential helpers of the user's own Git (their terminal's sign-in) are switched off for
// the command: what an agent can reach is what the token in Tools → GitHub allows.

export interface GitRun {
  code: number | null;
  out: string;
  err: string;
  /** Git is not installed, or not on the PATH. */
  missing?: true;
  timedOut?: true;
}

export const NO_GIT =
  "Git is not installed on this computer (or is not on the PATH), so this tool cannot work. The user installs it from https://git-scm.com/downloads and restarts HydraOps; the Tools page of the manual has the steps.";
export const NO_FOLDERS =
  "Git has no folder to work in yet. The user adds the folders it may use in HydraOps → Tools → Git (one per line). Until then this tool does nothing.";

const MAX_BUFFER = 16 * 1024 * 1024;

// Applied to every command. Nothing here is saved anywhere: it lasts for the one run.
const BASE_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "color.ui=false",
  "-c", "core.pager=cat",
  // A file-system monitor is a program the repository's configuration names: not run from here.
  "-c", "core.fsmonitor=false",
  "-c", "advice.detachedHead=false",
  // The user's own sign-in (Git Credential Manager, a stored password) is never used.
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  // A folder inside a working tree that is laid out as a repository of its own (a cloned
  // project can carry one) is not taken for one: its configuration, which can name programs
  // to run, would otherwise be obeyed by a command run from that folder.
  "-c", "safe.bareRepository=explicit",
  // Only GitHub over HTTPS is ever reached: no repository on this computer as a remote.
  "-c", "protocol.file.allow=never",
];

const gitBin = () => process.env.HYDRA_GIT_BIN || "git";

export function runGit(cwd: string, args: string[], opts: { timeoutMs?: number; config?: string[] } = {}): Promise<GitRun> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Never wait for someone to type a user name or a password.
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_MERGE_AUTOEDIT: "no",
    LANGUAGE: "en",
    LC_MESSAGES: "C",
    // The key-proxy is on this computer: a proxy set for the Internet is not on the way to it.
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  // The repository is the folder the command runs in, whatever this process inherited.
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS"]) delete env[k];
  return new Promise((resolve) => {
    execFile(gitBin(), ["--no-pager", ...BASE_CONFIG, ...(opts.config ?? []), ...args], {
      cwd, env: env as NodeJS.ProcessEnv, windowsHide: true, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 60_000,
    }, (error: any, stdout, stderr) => {
      const out = String(stdout ?? ""), err = String(stderr ?? "");
      if (!error) return resolve({ code: 0, out, err });
      if (error.code === "ENOENT") return resolve({ code: null, out, err, missing: true });
      // More output than fits: what arrived is kept, and the caller cuts it anyway.
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 0, out, err });
      if (error.killed) return resolve({ code: null, out, err, timedOut: true });
      resolve({ code: typeof error.code === "number" ? error.code : 1, out, err });
    });
  });
}

/** The installed Git and Git LFS, for the card in Tools: null when one is not there. */
export async function gitVersions(): Promise<{ git: string | null; lfs: string | null }> {
  const cwd = process.cwd();
  const g = await runGit(cwd, ["--version"], { timeoutMs: 10_000 });
  if (g.code !== 0) return { git: null, lfs: null };
  const l = await runGit(cwd, ["lfs", "version"], { timeoutMs: 10_000 });
  return {
    // "2.55.0", without the packager's suffix (".windows.3").
    git: g.out.trim().replace(/^git version\s*/i, "").replace(/\.(windows|vfs)\.[\d.]+$/i, "") || "?",
    lfs: l.code === 0 ? (l.out.match(/git-lfs\/([\w.]+)/)?.[1] ?? "?") : null,
  };
}

// ── Folders ───────────────────────────────────────────────────────────────────

const norm = (p: string) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };

/** True when `child` is `parent` or lies under it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const real = async (p: string): Promise<string | null> => { try { return await realpath(p); } catch { return null; } };

/** The allowed folders that exist, each as the real folder it names (a link is followed). */
export async function realFolders(folders: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of folders) {
    const r = typeof f === "string" && path.isAbsolute(f) ? await real(f) : null;
    if (r && !out.some((x) => norm(x) === norm(r))) out.push(r);
  }
  return out;
}

const listed = (folders: string[]) => folders.map((f) => `"${f}"`).join(", ");
const outside = (what: string, folders: string[]) =>
  `${what} is outside the folders Git may work in (${listed(folders)}). The user changes them in HydraOps → Tools → Git.`;

/**
 * The folder a call names, checked against the allowed ones. `repo` is an absolute path,
 * or a path relative to an allowed folder; with none given and a single allowed folder,
 * that folder. With `mayNotExist` (a clone's destination, a repository to create) the
 * nearest folder that exists is the one checked.
 */
export async function resolveDir(repo: unknown, folders: string[], mayNotExist = false): Promise<{ dir: string } | { error: string }> {
  const allowed = await realFolders(folders);
  if (!allowed.length) return { error: NO_FOLDERS };
  const want = typeof repo === "string" ? repo.trim() : "";
  if (!want) {
    if (allowed.length === 1) return { dir: allowed[0] };
    return { error: `Say which folder with \`repo\`: Git may work in ${listed(allowed)}.` };
  }
  const candidates = path.isAbsolute(want) ? [path.resolve(want)] : allowed.map((f) => path.resolve(f, want));
  for (const c of candidates) {
    const r = await real(c);
    if (r) {
      if (!allowed.some((f) => isInside(f, r))) continue;
      const st = await stat(r).catch(() => null);
      if (!st?.isDirectory()) return { error: `"${want}" is a file, not a folder.` };
      return { dir: r };
    }
    if (!mayNotExist) continue;
    // Not there yet: the nearest folder that exists decides.
    let up = path.dirname(c), tail = path.basename(c);
    for (let i = 0; i < 6; i++) {
      const ru = await real(up);
      if (ru) { if (allowed.some((f) => isInside(f, ru))) return { dir: path.join(ru, tail) }; break; }
      tail = path.join(path.basename(up), tail);
      const next = path.dirname(up);
      if (next === up) break;
      up = next;
    }
  }
  if (path.isAbsolute(want) && (await real(want)) === null && !mayNotExist) return { error: `The folder "${want}" does not exist.` };
  return { error: outside(`"${want}"`, allowed) };
}

const firstLines = (s: string, n = 12) => s.trim().split(/\r?\n/).slice(0, n).join("\n");

/** Git's words with the key-proxy's address read back as GitHub's: the agent works with GitHub, not with the proxy. */
export const asGitHub = (s: string) => s.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/githubgit\//g, "https://github.com/");

/** Why a command failed, as Git said it. */
export function gitFail(r: GitRun): string {
  if (r.missing) return NO_GIT;
  if (r.timedOut) return "Git took too long and was stopped.";
  return `Git refused:\n${asGitHub(firstLines(r.err || r.out)) || `(exit code ${r.code})`}`;
}

/** The repository `dir` belongs to: its top folder, which must be an allowed one too. */
export async function repoTop(dir: string, folders: string[]): Promise<{ top: string } | { error: string }> {
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (r.missing) return { error: NO_GIT };
  if (r.code !== 0) {
    if (/cannot use bare repository/i.test(r.err)) return { error: `"${dir}" is laid out as a Git repository of its own inside another folder (no working files, only Git's data). This tool does not work in such a folder: use the project's own folder.` };
    if (/not a git repository/i.test(r.err)) return { error: `"${dir}" is not a Git repository yet. git_write with action "init" makes it one.` };
    return { error: gitFail(r) };
  }
  const top = (await real(r.out.trim())) ?? path.resolve(r.out.trim());
  const allowed = await realFolders(folders);
  if (!allowed.some((f) => isInside(f, top))) return { error: outside(`"${dir}" belongs to a repository that starts at "${top}", which`, allowed) };
  return { top };
}

/**
 * A folder the user wants to allow, checked before it is saved: it must be an absolute
 * path to a folder that exists, and neither hold nor sit inside one of HydraOps' own
 * private folders (the key store, the data folder).
 */
export async function checkGitFolder(p: unknown, privateDirs: string[]): Promise<{ folder: string } | { error: "not_absolute" | "not_found" | "not_a_folder" | "private" }> {
  const want = typeof p === "string" ? p.trim().replace(/^"(.*)"$/, "$1") : "";
  if (!want || !path.isAbsolute(want)) return { error: "not_absolute" };
  const r = await real(want);
  if (!r) return { error: "not_found" };
  const st = await stat(r).catch(() => null);
  if (!st?.isDirectory()) return { error: "not_a_folder" };
  for (const d of privateDirs) {
    const rd = (await real(d)) ?? path.resolve(d);
    if (isInside(r, rd) || isInside(rd, r)) return { error: "private" };
  }
  return { folder: r };
}

// ── GitHub remotes ────────────────────────────────────────────────────────────

/** owner and repository of a github.com address, in any of the forms Git accepts. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const u = String(url ?? "").trim();
  const m = u.match(/^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    ?? u.match(/^(?:[\w.-]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], repo: m[2] };
}

export const githubUrl = (g: { owner: string; repo: string }) => `https://github.com/${g.owner}/${g.repo}.git`;

const proxyBase = () => (process.env.KEY_PROXY_URL || "http://127.0.0.1:9099").trim().replace(/\/$/, "");
/** Where the key-proxy answers for a GitHub repository's Git traffic. */
export const proxyGitUrl = (g: { owner: string; repo: string }) => `${proxyBase()}/githubgit/${g.owner}/${g.repo}.git`;

/** For one command only: `address` is reached through the key-proxy, and no other proxy is on the way. */
export const viaProxy = (address: string, g: { owner: string; repo: string }) =>
  ["-c", `url.${proxyGitUrl(g)}.insteadOf=${address}`, "-c", "http.proxy="];

/** Whether a GitHub token is stored in HydraOps (the key-proxy tells which services have one, never the value). */
export async function githubConnected(): Promise<boolean> {
  try {
    const r = await fetch(`${proxyBase()}/health`, { signal: AbortSignal.timeout(5000) });
    const d: any = await r.json();
    return Array.isArray(d?.configured) && d.configured.includes("github");
  } catch { return false; }
}

const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/;
/** An address as it may be shown: no user name or password in it. */
export const shownUrl = (u: string) => u.replace(/^([a-z]+:\/\/)[^@/\s]+@/i, "$1");

export interface RemoteTarget { remote: string; github: { owner: string; repo: string }; config: string[] }

/** The GitHub repository a remote of `dir` points at, and the rewrite that reaches it through the key-proxy. */
export async function remoteTarget(dir: string, remote: unknown): Promise<RemoteTarget | { error: string }> {
  const name = typeof remote === "string" && remote.trim() ? remote.trim() : "origin";
  if (!REMOTE_NAME.test(name)) return { error: `"${name}" is not a remote's name.` };
  const config: string[] = [];
  let github: { owner: string; repo: string } | null = null;
  for (const key of [`remote.${name}.url`, `remote.${name}.pushurl`]) {
    const r = await runGit(dir, ["config", "--get-all", key]);
    if (r.missing) return { error: NO_GIT };
    const urls = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (key.endsWith(".url") && !urls.length) {
      return { error: `This repository has no remote named "${name}". git_write with action "set_remote" adds one (a GitHub address).` };
    }
    for (const u of urls) {
      const g = parseGithubRemote(u);
      if (!g) return { error: `The remote "${name}" is ${shownUrl(u)}, which is not on github.com. This tool only exchanges commits with GitHub.` };
      if (!github) github = g;
      config.push(...viaProxy(u, g));
    }
  }
  return { remote: name, github: github!, config };
}

/** The branch that is checked out, or null on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}

/** A branch name Git itself accepts, with nothing that could be read as an option. */
export async function validBranch(dir: string, name: unknown): Promise<boolean> {
  const b = typeof name === "string" ? name.trim() : "";
  if (!b || b.startsWith("-") || b.length > 200 || /[\s:^~?*\[\\]/.test(b)) return false;
  return (await runGit(dir, ["check-ref-format", "--branch", b])).code === 0;
}

// ── What a push would send ────────────────────────────────────────────────────

export interface PushPreview {
  repo: string;
  branch: string;
  remote: string;
  /** owner/repository on GitHub. */
  target: string;
  /** The branch does not exist on the remote yet (as far as the last fetch knows). */
  newBranch: boolean;
  total: number;
  commits: { hash: string; subject: string; author: string; date: string }[];
}

const PREVIEW_COMMITS = 20;

/** The commits a held push would send, read from the repository as it is now (for the approval card). */
export async function pushPreview(args: any, folders: string[]): Promise<PushPreview | { error: string }> {
  const where = await resolveDir(args?.repo, folders);
  if ("error" in where) return where;
  const top = await repoTop(where.dir, folders);
  if ("error" in top) return top;
  const dir = top.top;
  const branch = typeof args?.branch === "string" && args.branch.trim() ? args.branch.trim() : await currentBranch(dir);
  if (!branch || !(await validBranch(dir, branch))) return { error: "No branch to push." };
  const target = await remoteTarget(dir, args?.remote);
  if ("error" in target) return target;
  const tracking = `refs/remotes/${target.remote}/${branch}`;
  const known = (await runGit(dir, ["rev-parse", "--verify", "-q", tracking])).code === 0;
  const range = known ? [`${tracking}..refs/heads/${branch}`] : [`refs/heads/${branch}`, "--not", `--remotes=${target.remote}`];
  const count = await runGit(dir, ["rev-list", "--count", ...range]);
  if (count.code !== 0) return { error: gitFail(count) };
  const log = await runGit(dir, ["log", `-n${PREVIEW_COMMITS}`, "--date=short", "--pretty=format:%h%x1f%s%x1f%an%x1f%ad", ...range]);
  const commits = log.out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, subject, author, date] = l.split("\x1f");
    return { hash: hash ?? "", subject: (subject ?? "").slice(0, 200), author: author ?? "", date: date ?? "" };
  });
  return { repo: dir, branch, remote: target.remote, target: `${target.github.owner}/${target.github.repo}`, newBranch: !known, total: Number(count.out.trim()) || commits.length, commits };
}

/** True when the folder has nothing in it (or is not there). */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try { return (await readdir(dir)).length === 0; } catch (e: any) { return e?.code === "ENOENT"; }
}

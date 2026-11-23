import { execFile, spawn } from "node:child_process";
import { lstat, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inTurn } from "../../in-turn.js";
import { pgit, type ProjectSpace } from "./core.js";

// Commands in a project: an install, a test run, a build.
//
// A command runs on the user's own computer, as the user HydraOps runs as, with the tools
// installed there: whatever the project is written in works without preparing anything.
// Nothing isolates it. What stands between a command and the computer is the user: every
// command is held, shown to them exactly as it will run, and runs only if they approve it
// (the tool declares `approval: "always"`; see provenance.ts). There is no approval for the
// rest of a task here: the next command is another decision.
//
// It runs in the agents' working copy of the project, where the agent's changes are, with
// one shell everywhere so the agent writes one syntax: bash (on Windows, the one that comes
// with Git, which a project needs anyway), and the system's own shell only when there is no
// bash. HydraOps' own settings are taken out of its environment.

export interface HostShell {
  /** The program that runs the command line. */
  program: string;
  args: (command: string) => string[];
  /** For the agent: which syntax to write. */
  syntax: "bash" | "sh" | "powershell";
  /** In words, for the agent and the user: "Windows, bash (from Git)". */
  described: string;
}

const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;
const execOut = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
});

let cachedShell: HostShell | null = null;

/** The shell commands run in on this computer. */
export async function hostShell(): Promise<HostShell> {
  if (cachedShell) return cachedShell;
  const system = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  if (process.platform === "win32") {
    // Git for Windows ships bash next to git: <Git>\bin\bash.exe, found from where git keeps its programs.
    const candidates: string[] = [];
    const execPath = await execOut("git", ["--exec-path"]);
    if (execPath) for (const up of [3, 2]) candidates.push(path.join(path.resolve(execPath, ...Array(up).fill("..")), "bin", "bash.exe"));
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]) {
      if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    }
    for (const c of candidates) {
      if (await exists(c)) return (cachedShell = { program: c, args: (command) => ["-c", command], syntax: "bash", described: `${system}, bash (the one that comes with Git)` });
    }
    const ps = (await execOut("where.exe", ["pwsh.exe"])).split(/\r?\n/)[0] || "powershell.exe";
    return (cachedShell = { program: ps, args: (command) => ["-NoProfile", "-NonInteractive", "-Command", command], syntax: "powershell", described: `${system}, PowerShell (no bash was found)` });
  }
  if (await exists("/bin/bash")) return (cachedShell = { program: "/bin/bash", args: (command) => ["-c", command], syntax: "bash", described: `${system}, bash` });
  return (cachedShell = { program: "/bin/sh", args: (command) => ["-c", command], syntax: "sh", described: `${system}, sh` });
}

// HydraOps' own settings do not travel to a command: where its database and its services
// are, its network token, the port it listens on (a development server would take it for
// its own), and what was set to run HydraOps itself.
const OWN_ENV = /^(HYDRA_|KEY_PROXY_|DATABASE_URL$|NATS_URL$|RESULTS_DIR$|SERVICE_NAME$|TELEGRAM_BOT_TOKEN$|PORT$|NODE_OPTIONS$|ELECTRON_|TSX_)/i;

export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !OWN_ENV.test(k)) out[k] = v;
  // Nobody is there to answer a prompt, and the output is read as text.
  return { ...out, CI: "1", TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false", npm_config_fund: "false" };
}

// Git belongs to the tab: the user accepts and commits there, and the working copy is a
// worktree of their repository. Looking is fine; anything else is refused before it runs.
const GIT_READS = new Set(["status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "blame", "grep", "describe", "shortlog", "cat-file", "version", "help", "--version", "--help"]);

/** The Git command in a command line that would change something, or null. */
export function gitWrite(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n&()]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Leading NAME=value pairs and wrappers do not change which program runs.
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["sudo", "env", "command", "exec", "time", "nohup"].includes(words[i]))) i++;
    if (!/^(git|git\.exe)$/i.test(path.basename(words[i] ?? "").replace(/^["']|["']$/g, ""))) continue;
    i++;
    // Options of git itself, before the subcommand: -C <dir>, -c <name=value>, --git-dir=…
    while (i < words.length && words[i].startsWith("-")) { if (words[i] === "-C" || words[i] === "-c") i++; i++; }
    const sub = (words[i] ?? "").toLowerCase();
    if (!sub || GIT_READS.has(sub)) continue;
    return `git ${sub}`;
  }
  return null;
}

/**
 * A repository a command started inside the copy (generators run `git init`) is not kept as
 * one: its Git data is removed and its files stay, as files of the project. Left there, the
 * project's own Git records the folder as a link to another repository instead of its
 * files. Returns the folders it was taken from.
 */
export async function removeNestedRepositories(space: ProjectSpace): Promise<string[]> {
  const removed = new Set<string>();
  const drop = async (repoDir: string, prefix: string, rel: string) => {
    if (!rel || rel.split("/").some((part) => part === ".." || part === "" || part.toLowerCase() === ".git")) return;
    const nested = path.join(repoDir, ...rel.split("/"), ".git");
    if (!(await lstat(nested).catch(() => null))) return;
    await rm(nested, { recursive: true, force: true }).catch(() => {});
    removed.add(prefix ? `${prefix}/${rel}` : rel);
  };
  for (const r of space.repos) {
    // Already staged as a link to another repository (the list of changes stages what it finds).
    const staged = await pgit(r.dir, ["ls-files", "-s", "-z"], { timeoutMs: 60_000 });
    if (staged.code === 0) {
      for (const entry of staged.out.split("\0")) {
        const m = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
        if (!m) continue;
        // One the user's own branch has (a real submodule) stays as it is.
        const inHead = await pgit(r.dir, ["ls-tree", "HEAD", "--", m[1]]);
        if (inHead.code === 0 && /^160000 /.test(inHead.out)) continue;
        // Taken out of the index as an entry, whatever state it is in: the files are staged as files by the next look at the changes.
        await pgit(r.dir, ["update-index", "--force-remove", "--", m[1]]);
        await drop(r.dir, r.prefix, m[1]);
      }
    }
    // Not staged yet: Git lists a folder that is a repository of its own as one entry ending in "/".
    const st = await pgit(r.dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], { timeoutMs: 60_000 });
    if (st.code !== 0) continue;
    for (const entry of st.out.split("\0")) if (entry.startsWith("?? ") && entry.endsWith("/")) await drop(r.dir, r.prefix, entry.slice(3, -1));
  }
  return [...removed];
}

const MAX_COMMAND = 8000;
const MAX_OUTPUT = 7000;
export const RUN_DEFAULT_MINUTES = 10;
export const RUN_MAX_MINUTES = 30;

export interface RunRequest {
  command: string;
  /** A folder of the project to run in, as the project's paths name it ("" = its top). */
  cwd?: string;
  minutes?: number;
}

export interface RunResult {
  ok: boolean;
  /** Why it did not run at all, in words. */
  error?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  seconds?: number;
  output?: string;
  cwd?: string;
  shell?: string;
  /** Folders where the command started a repository of its own; its Git data was removed, the files stay. */
  nestedRepos?: string[];
}

/** The folder of the working copy for a folder of the project, or an error in words. */
export async function runFolder(space: ProjectSpace, cwdRaw: unknown): Promise<{ dir: string; shown: string } | { error: string }> {
  if (!space.repos.length) return { error: "The project has no repository to run a command in." };
  const single = space.repos.length === 1 && space.repos[0].prefix === "";
  const given = String(cwdRaw ?? "").trim();
  if (given.length > 1000) return { error: "That is not a folder of the project (the name is too long)." };
  // Slashes at the ends are taken off one by one: a pattern for "any number of them" would be slow on a long run of slashes.
  let cwd = given.split("\\").join("/");
  if (cwd.startsWith("./")) cwd = cwd.slice(1);
  let from = 0, to = cwd.length;
  while (from < to && cwd[from] === "/") from++;
  while (to > from && cwd[to - 1] === "/") to--;
  cwd = cwd.slice(from, to);
  if (cwd === "" || cwd === ".") {
    // Several repositories have no folder in common that is the project's: one of them has to be named.
    if (!single) return { error: `This project holds ${space.repos.length} repositories; give "cwd" as one of them or a folder inside it: ${space.repos.map((r) => r.prefix).join(", ")}.` };
    return { dir: space.repos[0].dir, shown: "the project's top folder" };
  }
  const parts = cwd.split("/");
  if (path.posix.isAbsolute(cwd) || /^[a-z]:/i.test(cwd) || parts.some((p) => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git")) return { error: `"${cwdRaw}" is not a folder of the project. Give it as the project's paths are written (apps/api), or leave it out for the top folder.` };
  const repo = single ? space.repos[0] : space.repos.find((r) => r.prefix === parts[0]);
  if (!repo) return { error: `"${cwdRaw}" is not in this project. Its repositories: ${space.repos.map((r) => r.prefix || "(the project itself)").join(", ")}.` };
  const abs = path.join(repo.dir, ...(single ? parts : parts.slice(1)));
  const st = await lstat(abs).catch(() => null);
  if (!st?.isDirectory()) return { error: `There is no folder "${cwd}" in the project${st ? " (that is not a folder)" : ""}.` };
  return { dir: abs, shown: cwd };
}

/** What stops a command before anyone is asked to approve it, in words; "" when nothing does. */
export function commandProblem(commandRaw: unknown): string {
  const command = String(commandRaw ?? "").trim();
  if (!command) return "No command was given.";
  if (command.length > MAX_COMMAND) return `The command is longer than ${MAX_COMMAND} characters. Put long steps in a script of the project and run that.`;
  if (command.includes("\u0000")) return "The command holds a character that cannot be run.";
  const git = gitWrite(command);
  if (git) return `"${git}" is not run here. Git on this project belongs to its tab: the user reviews your changes there and accepts them, which makes the commit. Leave it out; to look at the state, project_read has "changes" and "diff".`;
  return "";
}

export function killTree(pid: number): void {
  if (process.platform === "win32") { execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {}); return; }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

/**
 * Runs one command of a project on this computer and waits for it to end. One at a time per
 * project: two builds writing the same folders give neither a result to trust. The caller
 * has the user's approval for exactly this command.
 */
export function runInProject(space: ProjectSpace, req: RunRequest): Promise<RunResult> {
  return inTurn(`project-run:${space.project.id}`, async () => {
    const problem = commandProblem(req.command);
    if (problem) return { ok: false, error: problem };
    const command = String(req.command).trim();
    const where = await runFolder(space, req.cwd);
    if ("error" in where) return { ok: false, error: where.error };
    const shell = await hostShell();
    const minutes = Math.min(Math.max(Number(req.minutes) || RUN_DEFAULT_MINUTES, 1), RUN_MAX_MINUTES);

    const t0 = Date.now();
    const HEAD = Math.floor(MAX_OUTPUT / 4);
    const run = await new Promise<{ code: number | null; out: string; timedOut: boolean; failed: string }>((resolve) => {
      let head = "", tail = "", dropped = 0, timedOut = false, done = false;
      const take = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (head.length < HEAD) { const room = HEAD - head.length; head += text.slice(0, room); if (text.length > room) tail += text.slice(room); }
        else tail += text;
        if (tail.length > MAX_OUTPUT - HEAD) { dropped += tail.length - (MAX_OUTPUT - HEAD); tail = tail.slice(tail.length - (MAX_OUTPUT - HEAD)); }
      };
      const finish = (code: number | null, failed = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, out: dropped ? `${head}\n[… ${dropped} characters in the middle are not shown …]\n${tail}` : head + tail, timedOut, failed });
      };
      let child: ReturnType<typeof spawn>;
      try {
        // Its own process group, so that stopping it stops what it started too.
        child = spawn(shell.program, shell.args(command), { cwd: where.dir, env: commandEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      } catch (e: any) { resolve({ code: null, out: "", timedOut: false, failed: e?.message ?? "could not start" }); return; }
      const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); setTimeout(() => finish(null), 10_000).unref(); }, minutes * 60_000);
      child.stdout!.on("data", take);
      child.stderr!.on("data", take);
      child.on("error", (e: any) => finish(null, e?.message ?? "could not start"));
      child.on("close", (code) => finish(code));
    });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (run.failed) return { ok: false, error: `The command could not be started (${shell.described}): ${run.failed}` };
    const nestedRepos = await removeNestedRepositories(space).catch(() => [] as string[]);
    return { ok: true, exitCode: run.code, timedOut: run.timedOut, seconds, output: run.out, cwd: where.shown, shell: shell.described, nestedRepos };
  });
}

/** A run as the agent reads it. */
export function describeRun(command: string, r: RunResult, minutes: number): string {
  if (!r.ok) return `project_run: ${r.error}`;
  const head = `$ ${command}\n(in ${r.cwd}, on the user's computer: ${r.shell})`;
  const body = (r.output ?? "").replace(/\r\n/g, "\n").trimEnd() || "(no output)";
  const notes = r.nestedRepos?.length
    ? `\n\nNote: the command started a Git repository of its own in ${r.nestedRepos.map((n) => `"${n}"`).join(", ")}. Its Git data was removed and its files are kept as files of this project (which is one repository already). Pass the generator's flag that skips Git next time (--skip-git, --no-git).`
    : "";
  if (r.timedOut) return `${head}\n\nSTOPPED after ${minutes} minute${minutes === 1 ? "" : "s"}: the command did not end, and it was stopped together with what it had started. A program that keeps running (a development server, a watcher) is not run here: tell the user how to start it. For a slow command, give more "minutes" (up to ${RUN_MAX_MINUTES}).\n\n${body}${notes}`;
  const code = r.exitCode;
  const verdict = code === 0 ? "exit code 0" : code === 127 ? "exit code 127 (the command was not found: the program is not installed on this computer, or not on its PATH)" : `exit code ${code} (it failed)`;
  return `${head}\n${verdict} · ${r.seconds} s\n\n${body}${notes}`;
}

/** What the agent and the user are told about commands on this computer. */
export async function commandsInfo(): Promise<{ system: string; shell: string; described: string }> {
  const s = await hostShell();
  return { system: `${os.type()} ${os.release()}`, shell: s.syntax, described: s.described };
}

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectsDir } from "@hydraops/config";
import type { ProjectRef } from "../../types.js";
import { inTurn } from "../../in-turn.js";
import { pgit, type ProjectSpace } from "./core.js";
import { commandEnv, commandProblem, hostShell, killTree, runFolder } from "./run.js";

// Programs of a project that keep running: a development server, a watcher.
//
// project_run waits for a command to end, so it cannot hold one of these. A server is
// started once (the user approves that start, as they approve a command: it runs on their
// computer, as their user, with nothing around it) and stays up after the agent's turn. The
// process that started it keeps it and writes what it prints to a file; any HydraOps service
// can tell whether it is alive, read that file and stop it, since the state is on disk. It
// ends when the user or the agent stops it, when the project is deleted, and when HydraOps
// stops; one left behind by a crash is found and stopped at the next start.
//
// A server runs the project's code as the agent's working copy has it. The files with the
// user's secrets (.env, .dev.vars) are not in that copy. The user can name, per project, the
// ones a server needs: they are copied in when a server starts and taken out when the last
// one stops. The agent's file tools still refuse them; the server's code, which the agent
// may have changed, can read them, and the approval card says so.

export interface ServerState {
  name: string;
  command: string;
  /** The folder of the project it runs in, as the project's paths name it. */
  cwd: string;
  pid: number;
  /** The HydraOps process that started it and keeps its output. */
  ownerPid: number;
  startedAt: string;
  status: "running" | "stopped";
  exitCode?: number | null;
  stoppedAt?: string;
  /** Why it is not running, when it was not the user's or the agent's doing. */
  note?: string;
  /** The first address it printed (http://localhost:5173). */
  url?: string;
  shell: string;
  /**
   * On Windows: the processes of the server (the shell and everything under it), each with
   * the moment it was created. The shell can end while the program it started lives on, and
   * a process number alone can come to name another program later.
   */
  tree?: { pid: number; started: string }[];
}

export const MAX_SERVERS = 3;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/i;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const START_WAIT_MS = 15_000;

const serversDir = (project: ProjectRef) => path.join(projectsDir, project.id, "servers");
const stateFile = (project: ProjectRef, name: string) => path.join(serversDir(project), `${name}.json`);
const logFile = (project: ProjectRef, name: string) => path.join(serversDir(project), `${name}.log`);
const secretsFile = (project: ProjectRef) => path.join(serversDir(project), "secrets-copied.json");

export const serverName = (raw: unknown): string | null => {
  const n = String(raw ?? "").trim() || "server";
  return NAME_RE.test(n) ? n.toLowerCase() : null;
};

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

// ── A server is more than one process ─────────────────────────────────────────
// The command runs under a shell, and a development server starts helpers of its own. The
// shell can end (when the HydraOps process that started it dies, for one) while the server
// it started goes on listening. So "is it running" and "stop it" are about the whole set:
//  - Linux: every process of the server carries a mark in its environment, and is found by it.
//  - Windows: the set is written down (number and creation time) while the server runs.
//  - elsewhere: the process group the server was started in.

const MARK = "HYDRAOPS_SERVER";
const markOf = (project: ProjectRef, name: string) => `${project.id}/${name}`;

const run = (file: string, args: string[], timeoutMs = 20_000) => new Promise<string>((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? "")));
});

/** Windows: every process as "pid parent created". */
async function windowsProcesses(): Promise<Map<number, { parent: number; started: string }>> {
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())\" }"], 30_000);
  const map = new Map<number, { parent: number; started: string }>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), { parent: Number(m[2]), started: m[3] });
  }
  return map;
}

/** Windows: a process and everything under it, as it is now. */
async function windowsTree(root: number): Promise<{ pid: number; started: string }[]> {
  const all = await windowsProcesses();
  if (!all.has(root)) return [];
  const out = [{ pid: root, started: all.get(root)!.started }];
  for (let i = 0; i < out.length && out.length < 400; i++) {
    for (const [pid, p] of all) {
      // A child was created after its parent: a number reused by an older process is not one.
      if (p.parent === out[i].pid && !out.some((o) => o.pid === pid) && BigInt(p.started) >= BigInt(out[i].started)) out.push({ pid, started: p.started });
    }
  }
  return out;
}

/** Linux: the processes that carry this server's mark. */
async function linuxMarked(mark: string): Promise<number[]> {
  const out: number[] = [];
  let entries: string[] = [];
  try { entries = await readdir("/proc"); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const env = await readFile(`/proc/${e}/environ`, "utf8").catch(() => "");
    if (env.split("\0").includes(`${MARK}=${mark}`)) out.push(Number(e));
  }
  return out;
}

const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** Whether anything of the server is still there. Quick: it is asked every few seconds. */
function serverAlive(s: ServerState): boolean {
  if (process.platform === "win32") return alive(s.pid) || (s.tree ?? []).some((t) => alive(t.pid));
  return alive(s.pid) || groupAlive(s.pid);
}

/** Stops everything of the server. Only processes known to be its own are touched. */
async function killServer(project: ProjectRef, s: ServerState): Promise<void> {
  if (process.platform === "win32") {
    const now = await windowsProcesses();
    const recorded = s.tree?.length ? s.tree : [];
    // The ones written down that are still the same processes, and what they started since.
    const own = recorded.filter((t) => now.get(t.pid)?.started === t.started).map((t) => t.pid);
    for (const pid of own) await run("taskkill", ["/PID", String(pid), "/T", "/F"], 15_000);
    return;
  }
  if (process.platform === "linux") {
    for (const pid of await linuxMarked(markOf(project, s.name))) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    return;
  }
  // Its process group, when what leads or led it was started with this server's command.
  const members = await run("ps", ["-o", "command=", "-g", String(s.pid)]);
  if (members.includes(s.command)) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ } }
}

async function waitGone(s: ServerState, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries && serverAlive(s); i++) await new Promise((r) => setTimeout(r, 200));
  return !serverAlive(s);
}

async function readState(project: ProjectRef, name: string): Promise<ServerState | null> {
  try {
    const s = JSON.parse(await readFile(stateFile(project, name), "utf8"));
    return s && typeof s.name === "string" && typeof s.pid === "number" ? (s as ServerState) : null;
  } catch { return null; }
}
let writeSeq = 0;
/** Another process may read a state while it is written: the file is replaced whole, never seen half written. */
async function writeState(project: ProjectRef, s: ServerState): Promise<void> {
  await mkdir(serversDir(project), { recursive: true });
  const file = stateFile(project, s.name);
  const tmp = `${file}.${process.pid}.${++writeSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(s), "utf8");
    await rename(tmp, file);
  } catch {
    // Windows refuses the replacement while another process has the file open.
    await rm(tmp, { force: true }).catch(() => {});
    await writeFile(file, JSON.stringify(s), "utf8");
  }
}

// ── The user's secrets files ──────────────────────────────────────────────────

// The files a framework reads its local secrets from. The templates a repository ships are not secrets.
const SECRET_FILE_RE = /^\.(env|dev\.vars)(?!\.(example|sample|template)$)(\.[\w.-]+)?$/i;
const MAX_SECRET_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", ".next", ".angular", "target", ".venv", "venv", "__pycache__"]);

/** The secrets files in the user's project folder, as paths of the project (apps/api/.dev.vars). */
export async function secretCandidates(space: ProjectSpace): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= 40 || depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(path.join(dir, e.name), r, depth + 1); }
      else if (e.isFile() && SECRET_FILE_RE.test(e.name)) out.push(r);
    }
  };
  for (const r of space.repos) await walk(r.source, r.prefix, 0);
  return out.slice(0, 40);
}

/** A chosen secrets file as two places: in the user's folder and in the agents' copy. Null when it is not one. */
function secretPlaces(space: ProjectSpace, rel: string): { source: string; dest: string; repoDir: string; inRepo: string } | null {
  const parts = String(rel).replace(/\\/g, "/").split("/");
  if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || !SECRET_FILE_RE.test(parts[parts.length - 1])) return null;
  const single = space.repos.length === 1 && space.repos[0].prefix === "";
  const repo = single ? space.repos[0] : space.repos.find((r) => r.prefix === parts[0]);
  if (!repo) return null;
  const inRepo = single ? parts : parts.slice(1);
  if (!inRepo.length) return null;
  return { source: path.join(repo.source, ...inRepo), dest: path.join(repo.dir, ...inRepo), repoDir: repo.dir, inRepo: inRepo.join("/") };
}

/** Which of the chosen files would be copied now, and why the others would not. */
export async function secretsPlan(space: ProjectSpace, chosen: string[]): Promise<{ copy: string[]; skipped: { file: string; why: string }[] }> {
  const copy: string[] = [];
  const skipped: { file: string; why: string }[] = [];
  for (const rel of [...new Set(chosen)].slice(0, 20)) {
    const at = secretPlaces(space, rel);
    if (!at) { skipped.push({ file: rel, why: "it is not a secrets file of this project" }); continue; }
    const src = await lstat(at.source).catch(() => null);
    if (!src?.isFile()) { skipped.push({ file: rel, why: "it is not in the user's folder any more" }); continue; }
    if (src.size > MAX_SECRET_BYTES) { skipped.push({ file: rel, why: "it is too large to be a secrets file" }); continue; }
    if (await lstat(at.dest).catch(() => null)) { skipped.push({ file: rel, why: "the project's repository already has a file with that name" }); continue; }
    // A file Git does not ignore would show in the pending change and could be committed.
    const ignored = await pgit(at.repoDir, ["check-ignore", "-q", "--", at.inRepo]);
    if (ignored.code !== 0) { skipped.push({ file: rel, why: "Git does not ignore it in this repository, so a copy would end up in the pending change" }); continue; }
    copy.push(rel);
  }
  return { copy, skipped };
}

async function copiedSecrets(project: ProjectRef): Promise<string[]> {
  try { const v = JSON.parse(await readFile(secretsFile(project), "utf8")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Copies the chosen secrets files into the agents' copy. What it copied is noted, to take it out again. */
async function placeSecrets(space: ProjectSpace, chosen: string[]): Promise<{ copied: string[]; skipped: { file: string; why: string }[] }> {
  const plan = await secretsPlan(space, chosen);
  const already = await copiedSecrets(space.project);
  const copied: string[] = [];
  for (const rel of plan.copy) {
    const at = secretPlaces(space, rel)!;
    await mkdir(path.dirname(at.dest), { recursive: true });
    await copyFile(at.source, at.dest);
    copied.push(rel);
  }
  if (copied.length) {
    await mkdir(serversDir(space.project), { recursive: true });
    await writeFile(secretsFile(space.project), JSON.stringify([...new Set([...already, ...copied])]), "utf8");
  }
  // One copied for an earlier server that is still there counts as in place.
  const skipped = plan.skipped.filter((s) => !(already.includes(s.file) && /already has a file/.test(s.why)));
  return { copied: [...new Set([...copied, ...chosen.filter((c) => already.includes(c))])], skipped };
}

/** Takes out of the agents' copy every secrets file that was copied in. */
export async function removeSecrets(space: ProjectSpace): Promise<number> {
  const list = await copiedSecrets(space.project);
  let n = 0;
  for (const rel of list) {
    const at = secretPlaces(space, rel);
    if (!at) continue;
    const st = await lstat(at.dest).catch(() => null);
    if (st?.isFile()) { await rm(at.dest, { force: true }).catch(() => {}); n++; }
  }
  await rm(secretsFile(space.project), { force: true }).catch(() => {});
  return n;
}

// A server is being started: its secrets are in the copy and its state is not written yet.
// Another process that sees no server running in that moment must leave the secrets alone.
const startingFile = (project: ProjectRef) => path.join(serversDir(project), "starting.lock");
const STARTING_MAX_MS = 2 * 60_000;
async function startingNow(project: ProjectRef): Promise<boolean> {
  const st = await stat(startingFile(project)).catch(() => null);
  // One left by a start that never finished (a crash) stops counting after a while.
  return !!st && Date.now() - st.mtimeMs < STARTING_MAX_MS;
}
async function runningOnDisk(project: ProjectRef): Promise<boolean> {
  let files: string[] = [];
  try { files = (await readdir(serversDir(project))).filter((f) => f.endsWith(".json") && f !== "secrets-copied.json"); } catch { return false; }
  for (const f of files) if ((await readState(project, f.slice(0, -5)))?.status === "running") return true;
  return false;
}
/**
 * Takes the copied secrets out when no server needs them. The order matters between
 * processes: a start writes its mark, then copies, then writes the server's state, then
 * removes its mark; so once secrets are noted as copied, either the mark or a running
 * state is there to be seen, and both are looked at after the note.
 */
async function removeSecretsIfIdle(space: ProjectSpace): Promise<number> {
  if (!(await copiedSecrets(space.project)).length) return 0;
  if (await startingNow(space.project)) return 0;
  if (await runningOnDisk(space.project)) return 0;
  return removeSecrets(space);
}

// ── Running ───────────────────────────────────────────────────────────────────

/** The servers this process started and still holds. */
const held = new Map<string, { child: ChildProcess; log: WriteStream; space: ProjectSpace }>();
const key = (project: ProjectRef, name: string) => `${project.id}/${name}`;

// An address a server prints for the user to open.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/i;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
export function firstUrl(text: string): string | null {
  const m = URL_RE.exec(stripAnsi(text));
  if (!m) return null;
  return m[0].replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost").replace(/[.,;:]+$/, "");
}

/** The servers of a project, each as it is now: one whose process is gone is marked stopped. */
export async function listServers(space: ProjectSpace): Promise<ServerState[]> {
  let names: string[] = [];
  try { names = (await readdir(serversDir(space.project))).filter((f) => f.endsWith(".json") && f !== "secrets-copied.json").map((f) => f.slice(0, -5)); } catch { return []; }
  const out: ServerState[] = [];
  for (const name of names.sort()) {
    const s = await readState(space.project, name);
    if (!s) continue;
    if (s.status === "running" && !serverAlive(s)) {
      s.status = "stopped"; s.stoppedAt = new Date().toISOString(); s.note = s.note ?? "its process is no longer there";
      await writeState(space.project, s).catch(() => {});
    }
    out.push(s);
  }
  if (!out.some((s) => s.status === "running")) await removeSecretsIfIdle(space).catch(() => 0);
  return out;
}

export interface StartResult { ok: boolean; error?: string; state?: ServerState; output?: string; secrets?: string[]; skippedSecrets?: { file: string; why: string }[] }

/** Starts a server of the project and waits a little: until it prints an address, ends, or a few seconds pass. */
export function startServer(space: ProjectSpace, req: { name?: unknown; command: unknown; cwd?: unknown }, secrets: string[] = []): Promise<StartResult> {
  return inTurn(`project-server:${space.project.id}`, async () => {
    const name = serverName(req.name);
    if (!name) return { ok: false, error: 'A server\'s name is a short word (letters, digits, "-" and "_"), e.g. "api" or "web".' };
    const problem = commandProblem(req.command);
    if (problem) return { ok: false, error: problem };
    const command = String(req.command).trim();
    const where = await runFolder(space, req.cwd);
    if ("error" in where) return { ok: false, error: where.error };
    const running = (await listServers(space)).filter((s) => s.status === "running");
    if (running.some((s) => s.name === name)) return { ok: false, error: `A server named "${name}" is already running (${running.find((s) => s.name === name)!.command}). Stop it first, or give this one another name.` };
    if (running.length >= MAX_SERVERS) return { ok: false, error: `This project already has ${MAX_SERVERS} servers running (${running.map((s) => s.name).join(", ")}). Stop one first.` };

    const shell = await hostShell();
    await mkdir(serversDir(space.project), { recursive: true });
    // From here until the server's state is written, the secrets in the copy are this start's.
    await writeFile(startingFile(space.project), String(process.pid), "utf8");
    const started = () => rm(startingFile(space.project), { force: true }).catch(() => {});
    let placed: Awaited<ReturnType<typeof placeSecrets>>;
    try { placed = await placeSecrets(space, secrets); } catch (e) { await started(); if (!running.length) await removeSecrets(space).catch(() => 0); throw e; }
    const log = createWriteStream(logFile(space.project, name), { flags: "w" });
    let child: ChildProcess;
    try {
      child = spawn(shell.program, shell.args(command), { cwd: where.dir, env: { ...commandEnv(), [MARK]: markOf(space.project, name) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e: any) {
      log.end();
      await started();
      if (!running.length) await removeSecrets(space).catch(() => 0);
      return { ok: false, error: `The server could not be started (${shell.described}): ${e?.message ?? "unknown"}` };
    }
    // Listened to from its first instant: a command that ends at once would otherwise print
    // and close before anyone was there, and its end would never be seen.
    const first: { chunks: Buffer[]; end?: { code: number | null; note?: string } } = { chunks: [] };
    let onData = (chunk: Buffer) => { first.chunks.push(chunk); };
    let onEnd = (code: number | null, note?: string) => { first.end = first.end ?? { code, note }; };
    child.stdout!.on("data", (c: Buffer) => onData(c));
    child.stderr!.on("data", (c: Buffer) => onData(c));
    child.on("error", (e: any) => onEnd(null, e?.message ?? "could not start"));
    child.on("close", (code) => onEnd(code));
    if (!child.pid) { log.end(); await started(); if (!running.length) await removeSecrets(space).catch(() => 0); return { ok: false, error: `The server could not be started (${shell.described}).` }; }

    let ended = false;
    const state: ServerState = { name, command, cwd: where.shown, pid: child.pid, ownerPid: process.pid, startedAt: new Date().toISOString(), status: "running", shell: shell.described };
    try { await writeState(space.project, state); } finally { await started(); }
    // On Windows the processes of the server are written down now and again a little later:
    // a development server starts its helpers in its first seconds.
    const noteTree = async () => {
      if (process.platform !== "win32" || ended) return;
      const tree = await windowsTree(child.pid!).catch(() => []);
      if (ended || !tree.length) return;
      const known = new Map((state.tree ?? []).map((t) => [`${t.pid}:${t.started}`, t]));
      for (const t of tree) known.set(`${t.pid}:${t.started}`, t);
      state.tree = [...known.values()];
      const current = await readState(space.project, name);
      if (current && current.status === "running") await writeState(space.project, { ...current, tree: state.tree }).catch(() => {});
    };
    for (const after of [1500, 8000, 30_000, 120_000]) setTimeout(() => { void noteTree(); }, after).unref();
    held.set(key(space.project, name), { child, log, space });

    let written = 0, early = "";
    let settle: () => void = () => {};
    const take = (chunk: Buffer) => {
      // The file keeps the start; past its limit the rest is dropped and said so once.
      if (written < MAX_LOG_BYTES) { log.write(chunk); written += chunk.length; if (written >= MAX_LOG_BYTES) log.write("\n[the output is longer than what is kept: the rest is not written]\n"); }
      if (early.length < 6000) early += chunk.toString("utf8");
      if (!state.url) { const url = firstUrl(early); if (url) { state.url = url; void writeState(space.project, state).catch(() => {}); settle(); } }
    };
    onData = take;
    for (const chunk of first.chunks.splice(0)) take(chunk);
    const finish = async (code: number | null, note?: string) => {
      if (ended) return;
      ended = true;
      held.delete(key(space.project, name));
      log.end();
      const now = (await readState(space.project, name)) ?? state;
      now.status = "stopped"; now.exitCode = code; now.stoppedAt = new Date().toISOString();
      if (note) now.note = note;
      Object.assign(state, now);
      await writeState(space.project, now).catch(() => {});
      // The last server out takes the secrets with it.
      if (![...held.keys()].some((k) => k.startsWith(`${space.project.id}/`))) await listServers(space).catch(() => []);
      settle();
    };
    onEnd = (code, note) => { void finish(code, note); };
    const waited = new Promise<void>((resolve) => { settle = resolve; setTimeout(resolve, START_WAIT_MS); });
    if (first.end) void finish(first.end.code, first.end.note);
    await waited;
    // A moment more once it has printed its address: what follows it is usually worth a line or two.
    if (!ended && state.url) await new Promise((r) => setTimeout(r, 800));
    if (!ended) await noteTree();
    return { ok: true, state: { ...state }, output: stripAnsi(early).slice(0, 4000), secrets: placed.copied, skippedSecrets: placed.skipped };
  });
}

/** Stops a server and everything it started. Works from any HydraOps process. */
export async function stopServer(space: ProjectSpace, nameRaw: unknown): Promise<{ ok: boolean; error?: string; state?: ServerState }> {
  const name = serverName(nameRaw);
  if (!name) return { ok: false, error: "That is not a server's name." };
  const state = await readState(space.project, name);
  if (!state) return { ok: false, error: `This project has no server named "${name}".` };
  if (serverAlive(state)) {
    // The shell and what is under it, while it is there; then whatever of the server outlived it.
    if (alive(state.pid) && state.status === "running") killTree(state.pid);
    await waitGone(state, 15);
    if (serverAlive(state)) { await killServer(space.project, state); }
    if (!(await waitGone(state))) return { ok: false, error: `The server "${name}" did not stop.` };
  }
  // The process that held it writes the same when it sees it end; whoever gets there first.
  const now = (await readState(space.project, name)) ?? state;
  if (now.status !== "stopped") { now.status = "stopped"; now.stoppedAt = new Date().toISOString(); now.note = "stopped"; await writeState(space.project, now).catch(() => {}); }
  else if (!now.note) { now.note = "stopped"; await writeState(space.project, now).catch(() => {}); }
  await listServers(space).catch(() => []);
  return { ok: true, state: now };
}

/** The last lines a server printed. */
export async function serverLog(project: ProjectRef, nameRaw: unknown, lines = 80): Promise<{ text: string; cut: boolean } | { error: string }> {
  const name = serverName(nameRaw);
  if (!name) return { error: "That is not a server's name." };
  const file = logFile(project, name);
  const st = await stat(file).catch(() => null);
  if (!st) return { error: `This project has no output of a server named "${name}".` };
  const want = Math.min(Math.max(Math.floor(Number(lines)) || 80, 1), 400);
  const span = Math.min(st.size, 96 * 1024);
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(span);
    await fh.read(buf, 0, span, st.size - span);
    const all = stripAnsi(buf.toString("utf8")).replace(/\r\n/g, "\n").split("\n");
    if (span < st.size) all.shift();
    const tail = all.slice(-want - 1);
    return { text: tail.join("\n").trimEnd(), cut: span < st.size || all.length > tail.length };
  } finally { await fh.close(); }
}

/** A deleted project leaves no server running and no secrets in its copy. */
export async function stopAllServers(space: ProjectSpace): Promise<void> {
  for (const s of await listServers(space)) if (s.status === "running") await stopServer(space, s.name).catch(() => {});
  await removeSecrets(space).catch(() => 0);
}

/** What a process was started with, to tell one of ours from another that got the same number. */
function commandLineOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}").CommandLine`], { windowsHide: true, timeout: 15_000 }, (_e, out) => resolve(String(out ?? "")));
    } else {
      readFile(`/proc/${Math.floor(pid)}/cmdline`, "utf8").then((t) => resolve(t.replace(/\0/g, " ")), () => resolve(""));
    }
  });
}

/**
 * At the start of the service that runs servers: one left running by a run of HydraOps that
 * ended without stopping it (a crash, a kill) is stopped, and its secrets are taken out.
 * Only a process that was started with that server's command is touched.
 */
export async function stopLeftoverServers(openSpace: (projectId: string) => Promise<ProjectSpace | null>): Promise<string[]> {
  const stopped: string[] = [];
  let ids: string[] = [];
  try { ids = await readdir(projectsDir); } catch { return stopped; }
  for (const id of ids) {
    let files: string[] = [];
    try { files = (await readdir(path.join(projectsDir, id, "servers"))).filter((f) => f.endsWith(".json") && f !== "secrets-copied.json"); } catch { continue; }
    if (!files.length) continue;
    const space = await openSpace(id).catch(() => null);
    for (const f of files) {
      const ref = { id } as ProjectRef;
      const s = await readState(ref, f.slice(0, -5));
      if (!s || s.status !== "running" || s.ownerPid === process.pid) continue;
      if (alive(s.ownerPid) && serverAlive(s)) continue; // another running HydraOps service holds it
      if (serverAlive(s)) {
        if (process.platform === "win32" && !s.tree?.length) {
          // Nothing was written down about it: only a process still started with its command is its own.
          if ((await commandLineOf(s.pid)).includes(s.command)) { killTree(s.pid); await waitGone(s, 40); }
        } else {
          await killServer(ref, s);
          await waitGone(s, 40);
        }
      }
      s.status = "stopped"; s.stoppedAt = new Date().toISOString(); s.note = "left running by an earlier run of HydraOps, and stopped when it started again";
      await writeState(ref, s).catch(() => {});
      stopped.push(`${id}/${s.name}`);
    }
    if (space) await listServers(space).catch(() => []);
  }
  return stopped;
}

// This process ends: what it started ends with it. On Windows the supervisor already stops
// the whole tree; elsewhere a server is in a group of its own and would stay behind.
let hooked = false;
export function stopServersOnExit(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const { child } of held.values()) {
      if (!child.pid) continue;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 8000 });
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* gone */ }
    }
  };
  process.on("exit", killAll);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => { killAll(); process.exit(0); });
}

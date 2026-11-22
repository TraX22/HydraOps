import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import { isSensitivePath } from "../../guard.js";
import { gitFail } from "../git/core.js";
import {
  openProject, spaceProblem, resolvePath, readTextFile, writeTextFile, listFiles, pendingChanges, fileDiff, pgit,
  readMemory, appendMemory, writeInstructions, setChangeSummary, INSTRUCTIONS_FILE, MEMORY_FILE, MAX_FILE_BYTES, type ProjectSpace,
} from "./core.js";
import { runInProject, describeRun, RUN_DEFAULT_MINUTES, RUN_MAX_MINUTES } from "./run.js";

// project_read / project_write / project_memory / project_instructions — what an agent has
// in a project's chat, and only there (scope "project": no tools.md grants them; the worker
// adds them when the task's chat is a project's, and binds which project it is).
//
//  - project_read looks at the code. What it returns was written by whoever wrote the
//    repository, so it comes back as outside content.
//  - project_write changes files in the agents' working copy (see core.ts). It does not wait
//    for approval, file by file: the copy is apart from the user's folder and the user
//    accepts or discards the whole change from the diff.
//  - project_memory keeps the project's notes (ProjectMemory.md, in the user's folder).
//  - project_instructions proposes new instructions (HydraOps.md): always the user's call.
//  - project_run runs a command of the project on the user's computer, in the working copy,
//    and only after the user approved that very command (see run.ts).

const NOT_A_PROJECT = "This tool works only in a project's chat (HydraOps → Projects), and this conversation is not one.";
const apiUrl = () => (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

async function spaceOf(ctx?: ToolContext): Promise<ProjectSpace | { error: string }> {
  if (!ctx?.project) return { error: NOT_A_PROJECT };
  const space = await openProject(ctx.project);
  const problem = spaceProblem(space);
  return problem ? { error: problem } : space;
}

const MAX_SHOWN = 60_000;
const MAX_LINE = 2_000;
const TREE_LINES = 400;

// ── The tree ──────────────────────────────────────────────────────────────────

interface Dir { dirs: Map<string, Dir>; files: string[]; total: number }
const newDir = (): Dir => ({ dirs: new Map(), files: [], total: 0 });

function buildTree(paths: string[]): Dir {
  const root = newDir();
  for (const p of paths) {
    const segs = p.split("/");
    let at = root;
    at.total++;
    for (const s of segs.slice(0, -1)) {
      if (!at.dirs.has(s)) at.dirs.set(s, newDir());
      at = at.dirs.get(s)!;
      at.total++;
    }
    at.files.push(segs[segs.length - 1]);
  }
  return root;
}

/** The tree as indented lines; a folder past `depth` is one line with how many files it holds. */
function renderTree(dir: Dir, depth: number, marks: Map<string, string>, base: string, indent = ""): string[] {
  const out: string[] = [];
  for (const [name, sub] of [...dir.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const full = base ? `${base}/${name}` : name;
    if (depth <= 1) { out.push(`${indent}${name}/  (${sub.total} file${sub.total === 1 ? "" : "s"})`); continue; }
    out.push(`${indent}${name}/`);
    out.push(...renderTree(sub, depth - 1, marks, full, `${indent}  `));
  }
  for (const f of dir.files.sort((a, b) => a.localeCompare(b))) {
    const mark = marks.get(base ? `${base}/${f}` : f);
    out.push(`${indent}${f}${mark ? `  [${mark}]` : ""}`);
  }
  return out;
}

// ── project_read ──────────────────────────────────────────────────────────────

export const projectReadTool: HydraTool = {
  name: "project_read",
  title: "Project: read",
  scope: "project",
  // Reads only. The code and its comments may come from other people; the list of names does not count.
  risk: (args: any) => (args?.action === "tree" || (args?.action === "changes" && !args?.path) ? {} : { readsExternal: true }),
  // The agent edits from the exact text: a digest of a file would be useless.
  vault: false,
  description:
    "Look at this project's code. Actions: \"tree\" (the files, as folders; `path` for one folder, `depth` to go deeper), \"read\" (one file by `path`, with line numbers that are not part of the file; `from` and `lines` for a part of a long one), \"search\" (`query` in the files' text: the exact words, or a regular expression with `regex`; `path` narrows it to a folder or file), \"changes\" (what you changed that the user has not accepted yet; with `path`, that file's diff).",
  schema: z.object({
    action: z.enum(["tree", "read", "search", "changes"]),
    path: z.string().optional().describe("A file or folder of the project, relative to its top (src/app/main.ts)."),
    depth: z.number().int().min(1).max(8).optional().describe("tree: how many levels of folders to open (default 3)."),
    from: z.number().int().min(1).optional().describe("read: the first line to show (default 1)."),
    lines: z.number().int().min(1).max(1500).optional().describe("read: how many lines (default 400)."),
    query: z.string().optional().describe("search: the text to look for."),
    regex: z.boolean().optional().describe("search: `query` is a regular expression."),
    ignore_case: z.boolean().optional().describe("search: upper and lower case count the same."),
  }),
  execute: async ({ action, path: p, depth, from, lines, query, regex, ignore_case }, ctx) => {
    try {
      const space = await spaceOf(ctx);
      if ("error" in space) return space.error;

      if (action === "tree") {
        const all = await listFiles(space);
        let under = "";
        if (typeof p === "string" && p.trim()) {
          const at = await resolvePath(space, p, { dirOk: true });
          if ("error" in at) return at.error;
          under = at.shown;
        }
        const inside = under ? all.filter((f) => f.startsWith(`${under}/`)).map((f) => f.slice(under.length + 1)) : all;
        if (!inside.length) return under ? `There are no files under "${under}" (or it is a file: read it).` : "The project has no files yet.";
        const marks = new Map<string, string>();
        for (const c of await pendingChanges(space)) {
          if (!under) marks.set(c.path, c.state);
          else if (c.path.startsWith(`${under}/`)) marks.set(c.path.slice(under.length + 1), c.state);
        }
        const tree = buildTree(inside);
        let d = depth ?? 3;
        let out = renderTree(tree, d, marks, "");
        while (out.length > TREE_LINES && d > 1) out = renderTree(tree, --d, marks, "");
        const cut = out.length > TREE_LINES;
        return `${under ? `${under}/` : "The project"}: ${inside.length} file${inside.length === 1 ? "" : "s"}${d < (depth ?? 3) ? ` (shown ${d} level${d === 1 ? "" : "s"} deep to fit; give \`path\` to open a folder)` : ""}\n${out.slice(0, TREE_LINES).join("\n")}${cut ? `\n… ${out.length - TREE_LINES} more lines: give \`path\` to open one folder` : ""}`;
      }

      if (action === "read") {
        const at = await resolvePath(space, p);
        if ("error" in at) return at.error;
        if (isSensitivePath(`/${at.shown}`)) return `"${at.shown}" is a credentials file: it is not opened.`;
        const file = await readTextFile(at.abs);
        if ("error" in file) return `${at.shown}: ${file.error}`;
        const all = file.text.split("\n");
        if (all.length > 1 && all[all.length - 1] === "") all.pop();
        const first = Math.min(from ?? 1, Math.max(all.length, 1));
        const shown: string[] = [];
        let size = 0, last = first - 1;
        for (let i = first - 1; i < all.length && shown.length < (lines ?? 400); i++) {
          const l = all[i].length > MAX_LINE ? `${all[i].slice(0, MAX_LINE)} [line cut: ${all[i].length} characters]` : all[i];
          size += l.length + 8;
          if (size > MAX_SHOWN && shown.length) break;
          shown.push(`${i + 1}\t${l}`);
          last = i + 1;
        }
        const more = last < all.length ? `\n[lines ${first}-${last} of ${all.length}: ask for more with \`from: ${last + 1}\`]` : "";
        return `${at.shown} (${all.length} line${all.length === 1 ? "" : "s"})\n${shown.join("\n")}${more}`;
      }

      if (action === "search") {
        const q = typeof query === "string" ? query : "";
        if (!q.trim()) return "search needs `query`.";
        if (q.length > 500) return "The search text is too long (500 characters at most).";
        const found: string[] = [];
        let total = 0;
        for (const repo of space.repos) {
          let scope: string[] = [];
          if (typeof p === "string" && p.trim()) {
            const at = await resolvePath(space, p, { dirOk: true });
            if ("error" in at) { if (space.repos.length === 1) return at.error; continue; }
            if (at.repo !== repo) continue;
            scope = at.rel ? ["--", at.rel] : [];
          }
          const r = await pgit(repo.dir, ["--literal-pathspecs", "grep", "-n", "-I", "--untracked", "--no-color", ...(ignore_case ? ["-i"] : []), regex ? "-E" : "-F", "-e", q, ...scope]);
          // 1: nothing found. Anything else is Git refusing (a bad expression).
          if (r.code !== 0 && r.code !== 1) return regex ? `That regular expression was not understood.\n${gitFail(r)}` : gitFail(r);
          for (const line of r.out.split(/\r?\n/)) {
            const m = line.match(/^(.+?):(\d+):(.*)$/);
            if (!m || isSensitivePath(`/${m[1]}`)) continue;
            total++;
            if (found.length < 120) found.push(`${repo.prefix ? `${repo.prefix}/` : ""}${m[1]}:${m[2]}: ${m[3].trim().slice(0, 300)}`);
          }
        }
        if (!total) return `Nothing in the project's files matches "${q}".`;
        return `${total} line${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""}${total > found.length ? ` (the first ${found.length} shown; narrow it with \`path\`)` : ""}:\n${found.join("\n")}`;
      }

      // changes
      if (typeof p === "string" && p.trim()) {
        const d = await fileDiff(space, p);
        if ("error" in d) return d.error;
        return d.diff ? `${d.diff}${d.cut ? "\n[diff cut: it is longer than what fits]" : ""}` : `"${p}" has no pending change.`;
      }
      const changes = await pendingChanges(space);
      if (!changes.length) return "Nothing is pending: the copy you work on is the same as the user's last commit.";
      return `${changes.length} file${changes.length === 1 ? "" : "s"} changed, waiting for the user to accept or discard:\n${changes.map((c) => `${c.state.padEnd(8)} ${c.path}${c.added === null ? "" : `  (+${c.added} -${c.removed})`}`).join("\n")}`;
    } catch (e: any) {
      return `The project could not be read: ${e?.message || e}`;
    }
  },
};

// ── project_write ─────────────────────────────────────────────────────────────

const countOf = (text: string, piece: string) => (piece ? text.split(piece).length - 1 : 0);

export const projectWriteTool: HydraTool = {
  name: "project_write",
  title: "Project: change files",
  scope: "project",
  // Writes files, in the agents' own copy. The worker lets it through on a task that read
  // outside content: reading the code is such a read, and the user decides on the diff.
  risk: { sensitive: true },
  // Only the paths are paths: a file's text may well name ".env" or show a command.
  guardedArgs: (args: any) => ({ path: args?.path, to: args?.to }),
  description:
    "Change this project's files, in the copy you work on: the user sees the result as a diff and accepts or discards it, so do not ask before each change. Actions: \"edit\" (replace exact pieces of a file: `edits`, each with `old`, the text as it is now, copied exactly and long enough to be found once, and `new`), \"write\" (a whole file's `content`: a new file, or one you are rewriting), \"delete\" (a file), \"move\" (`path` to `to`). Read a file before editing it. Prefer \"edit\" to rewriting a file that exists.",
  schema: z.object({
    action: z.enum(["edit", "write", "delete", "move"]),
    path: z.string().describe("The file, relative to the project's top (src/app/main.ts)."),
    edits: z.array(z.object({
      old: z.string().describe("The text to replace, exactly as it is in the file (without the line numbers project_read shows)."),
      new: z.string().describe("What takes its place (empty to remove it)."),
      all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
    })).min(1).max(30).optional().describe("edit: the replacements, applied in order."),
    content: z.string().optional().describe("write: the file's whole text."),
    to: z.string().optional().describe("move: the new path."),
    summary: z.string().optional().describe("With the last change of your turn: one line saying what the whole pending change does, as a commit message: under 72 characters, in English unless the user or the project's instructions ask for another language. The user gets it as the commit's message when they accept."),
  }),
  execute: async (args, ctx) => {
    const result = await changeFile(args, ctx);
    // The agent's line for the commit, kept only when the change itself was made.
    if (ctx?.project && typeof args?.summary === "string" && /^(Created|Rewrote|Edited|Deleted|Moved) /.test(String(result))) {
      await setChangeSummary(ctx.project, args.summary).catch(() => {});
    }
    return result;
  },
};

async function changeFile({ action, path: p, edits, content, to }: any, ctx?: ToolContext): Promise<string> {
    try {
      const space = await spaceOf(ctx);
      if ("error" in space) return space.error;
      const at = await resolvePath(space, p);
      if ("error" in at) return at.error;
      const ignoredNote = async (repoDir: string, rel: string) =>
        // check-ignore takes plain names (it has no pathspec magic to switch off).
        (await pgit(repoDir, ["check-ignore", "-q", "--", rel])).code === 0
          ? " Note: Git ignores this path in this repository, so the file will not be part of the change the user accepts."
          : "";

      if (action === "write") {
        if (typeof content !== "string") return "write needs `content`: the file's whole text.";
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return `That is too much for one file (${MAX_FILE_BYTES / 1024} KB at most).`;
        const st = await stat(at.abs).catch(() => null);
        if (st?.isDirectory()) return `"${at.shown}" is a folder.`;
        const before = st ? await readTextFile(at.abs) : null;
        if (before && "error" in before) return `${at.shown}: ${before.error} It was not overwritten.`;
        await writeTextFile(at.abs, content, before ?? {});
        return `${st ? "Rewrote" : "Created"} ${at.shown} (${content.split("\n").length} lines).${await ignoredNote(at.repo.dir, at.rel)}`;
      }

      if (action === "edit") {
        if (!Array.isArray(edits) || !edits.length) return "edit needs `edits`: one or more { old, new }.";
        const file = await readTextFile(at.abs);
        if ("error" in file) return `${at.shown}: ${file.error}${file.error.startsWith("There is no") ? " Create it with action \"write\"." : ""}`;
        let text = file.text;
        for (let i = 0; i < edits.length; i++) {
          const old = String(edits[i].old ?? "").replace(/\r\n/g, "\n"), next = String(edits[i].new ?? "").replace(/\r\n/g, "\n");
          const which = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : "";
          if (!old) return `${which}\`old\` is empty. Nothing was changed.`;
          if (old === next) return `${which}\`old\` and \`new\` are the same. Nothing was changed.`;
          const n = countOf(text, old);
          if (n === 0) return `${which}\`old\` is not in ${at.shown} as written (check spaces and line breaks, and leave the line numbers out). Nothing was changed: read the file again and retry.`;
          if (n > 1 && !edits[i].all) return `${which}\`old\` is in ${at.shown} ${n} times. Give more of the text around it so it is found once, or set \`all\`. Nothing was changed.`;
          text = edits[i].all ? text.split(old).join(next) : text.replace(old, () => next);
        }
        if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return `The file would be too large (${MAX_FILE_BYTES / 1024} KB at most). Nothing was changed.`;
        await writeTextFile(at.abs, text, file);
        return `Edited ${at.shown} (${edits.length} replacement${edits.length === 1 ? "" : "s"}).`;
      }

      const st = await stat(at.abs).catch(() => null);
      if (!st) return `There is no file "${at.shown}".`;
      if (!st.isFile()) return `"${at.shown}" is a folder: ${action} works on one file at a time.`;

      if (action === "delete") {
        await unlink(at.abs);
        return `Deleted ${at.shown}.`;
      }
      // move
      const dest = await resolvePath(space, to);
      if ("error" in dest) return typeof to === "string" && to.trim() ? dest.error : "move needs `to`: the new path.";
      if (dest.repo !== at.repo) return "A file cannot be moved from one repository to another: write it in the other one and delete it here.";
      if (await stat(dest.abs).catch(() => null)) return `"${dest.shown}" already exists. Nothing was moved.`;
      await mkdir(path.dirname(dest.abs), { recursive: true });
      await rename(at.abs, dest.abs);
      return `Moved ${at.shown} to ${dest.shown}.${await ignoredNote(dest.repo.dir, dest.rel)}`;
    } catch (e: any) {
      return `The file could not be changed: ${e?.message || e}`;
    }
}

// ── project_memory ────────────────────────────────────────────────────────────

export const projectMemoryTool: HydraTool = {
  name: "project_memory",
  title: "Project: notes",
  scope: "project",
  // Notes that later tasks of the project read: the worker lets "add" through like a file
  // change (the notes reach the prompt as notes, never as the user's instructions).
  risk: (args: any) => (args?.action === "search" || args?.action === "read" ? {} : { sensitive: true }),
  vault: false,
  // It takes no path (the file is always the project's notes): a note that names ".env" is prose.
  guardedArgs: () => ({}),
  description:
    `Keep this project's notes (${MEMORY_FILE}, which every agent working on the project gets in its context). Actions: "add" (one short note in \`text\`: a decision and its reason, how something is built, what was tried and failed; not what the code already says), "search" (the notes that mention \`query\`), "read" (all of them, when the context shows only a part).`,
  schema: z.object({
    action: z.enum(["add", "search", "read"]),
    text: z.string().optional().describe("add: the note, one or two self-contained sentences."),
    query: z.string().optional().describe("search: words to look for."),
  }),
  execute: async ({ action, text, query }, ctx) => {
    try {
      if (!ctx?.project) return NOT_A_PROJECT;
      if (action === "add") return await appendMemory(ctx.project, text, ctx.agentId ?? "");
      const memory = await readMemory(ctx.project);
      if (!memory.trim()) return `${MEMORY_FILE} has no notes yet.`;
      if (action === "read") return memory.length > MAX_SHOWN ? `${memory.slice(0, MAX_SHOWN)}\n[cut: ${memory.length - MAX_SHOWN} more characters; search for what you need]` : memory;
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      if (!words.length) return "search needs `query`.";
      const hits = memory.split("\n").filter((l) => { const low = l.toLowerCase(); return l.trim() && words.every((w) => low.includes(w)); });
      return hits.length ? hits.slice(0, 60).join("\n").slice(0, MAX_SHOWN) : `No note mentions "${query}".`;
    } catch (e: any) {
      return `The project's notes could not be reached: ${e?.message || e}`;
    }
  },
};

// ── project_instructions ──────────────────────────────────────────────────────

export const projectInstructionsTool: HydraTool = {
  name: "project_instructions",
  title: "Project: instructions",
  scope: "project",
  // The instructions rule every later task of the project: changing them is the user's
  // decision, every time, whatever the task read and whatever the security mode.
  risk: { sensitive: true, approval: "always" },
  // It takes no path (the file is always the project's instructions), and instructions
  // often name ".env" or show a command; the user reads the text before it is written.
  guardedArgs: () => ({}),
  description:
    `Propose new instructions for this project (${INSTRUCTIONS_FILE}: how the project is built and run, its conventions, what not to touch). Give the whole file in \`content\`, keeping what stays. It ALWAYS waits for the user's approval: call it once, say what you propose to change and why, and do not retry. Use it when the user asks you to write or update the project's instructions, not for notes (those go to project_memory).`,
  schema: z.object({
    content: z.string().describe(`The whole new ${INSTRUCTIONS_FILE}, in Markdown.`),
  }),
  execute: async ({ content }, ctx) => {
    try {
      const project = ctx?.project;
      if (!project) return NOT_A_PROJECT;
      if (typeof content !== "string" || !content.trim()) return "`content` is empty: give the whole file.";
      const written = await writeInstructions(project, content);
      if ("error" in written) return written.error;
      // The user approved this exact text: it is the one in force from now on.
      const r = await fetch(`${apiUrl()}/api/projects/${encodeURIComponent(project.id)}/instructions/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash: written.hash }), signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!r?.ok) return `${INSTRUCTIONS_FILE} was written, but it could not be marked as accepted: the user accepts it in the project's tab.`;
      return `${INSTRUCTIONS_FILE} was updated and is in force from the next message on.`;
    } catch (e: any) {
      return `The instructions could not be written: ${e?.message || e}`;
    }
  },
};

// ── project_run ───────────────────────────────────────────────────────────────

export const projectRunTool: HydraTool = {
  name: "project_run",
  title: "Project: run a command",
  scope: "project",
  // It runs on the user's computer with nothing around it: every call waits for the user,
  // who sees the exact command, and there is no approving the rest of the task at once.
  // What it prints was produced by the project's code and whatever that downloaded.
  risk: { sensitive: true, readsExternal: true, approval: "always" },
  // Its result is not digested or cut by the registry: the tool keeps the start and the end
  // of a long output itself, the end being where a build or a test run says how it went.
  vault: false,
  description:
    "Run a command of this project on the user's computer and get what it printed and its exit code: install dependencies, run the tests, type-check, build, run a script or a generator. " +
    "EVERY call waits for the user's approval: they see the exact command and the folder, and it runs only if they accept. So ask for what is needed and no more, chain what belongs together in one command (npm install && npm test), never repeat a command that already gave its answer, and say in your reply what you are waiting for. " +
    "Only this call asks for a command: a command written in your reply asks for nothing, and the user gets no card to approve. Never say a command is waiting, or that you asked for one, unless you called project_run in this turn and it answered that it is held. " +
    "It runs in HydraOps' working copy of the project (the files you wrote with project_write are there), with the tools installed on the user's computer: a program that is not installed there fails as not found; say so rather than installing system software. " +
    "What the command writes stays in the copy: the user sees it in the pending change, unless Git ignores it (node_modules, builds). The user's secrets files (.env) are not in the copy. " +
    "The command has to end by itself: a development server or a watcher is stopped when the time is up; tell the user how to start it instead. Nobody can answer a prompt: pass every choice as a flag (--yes, --no-interactive, --skip-git…). " +
    "Git commands that change anything are refused: the user accepts and commits from the project's tab. " +
    "Of a long output you get the start and the end; to see another part, narrow it in the command itself (… 2>&1 | grep -n error, | tail -n 80). " +
    "Report what actually happened: the command, its exit code and the lines that matter.",
  schema: z.object({
    command: z.string().describe('The command line, in the shell this project\'s section names (bash unless it says otherwise): "npm install", "npm test -- --run", "npx tsc --noEmit -p apps/api", "composer install && vendor/bin/phpunit".'),
    cwd: z.string().optional().describe("The folder of the project to run it in, as the project's paths are written (apps/api). Omit for the project's top folder."),
    minutes: z.number().optional().describe(`How long it may run before it is stopped (default ${RUN_DEFAULT_MINUTES}, up to ${RUN_MAX_MINUTES}).`),
  }),
  execute: async ({ command, cwd, minutes }, ctx) => {
    const space = await spaceOf(ctx);
    if ("error" in space) return space.error;
    const allowed = Math.min(Math.max(Number(minutes) || RUN_DEFAULT_MINUTES, 1), RUN_MAX_MINUTES);
    const result = await runInProject(space, { command: String(command ?? ""), cwd, minutes: allowed });
    return describeRun(String(command ?? "").trim(), result, allowed);
  },
};

export const projectTools: HydraTool[] = [projectReadTool, projectWriteTool, projectMemoryTool, projectInstructionsTool, projectRunTool];
export { runInProject, describeRun, commandProblem, runFolder, commandsInfo, hostShell, commandEnv, gitWrite, removeNestedRepositories } from "./run.js";
export {
  openProject, spaceProblem, pendingChanges, fileDiff, acceptChanges, discardChanges, repoState, removeWorkingCopies, initRepository,
  listFiles, discoverRepos, readInstructions, writeInstructions, readMemory, projectPrompt, INSTRUCTIONS_FILE, MEMORY_FILE,
  readProjectFile, writeProjectFile, getChangeSummary, clearChangeSummary, logProjectEvent, readProjectEvents, eventsPrompt,
  type ProjectSpace, type ProjectRepo, type ChangedFile, type AcceptResult, type ProjectFile, type ProjectEvent,
} from "./core.js";

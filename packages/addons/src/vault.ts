/**
 * The task vault: every long tool result is kept whole, on disk, and the model gets a
 * digest instead of a truncated copy.
 *
 * Until now each tool cut its own output (a page at 4 000 characters, a transcript at
 * 15 000, an MCP result at 8 000) and what fell off was gone for good: a long research
 * task ended up "remembering" the first screen of every page it read. Now the registry
 * hands every result through `store`: a short one passes untouched; a long one is
 * written to `storage/results/<task>/vault/<n>.txt`, and what reaches the model is the
 * head of the text, an index of its sections and a marker that says how to get the
 * rest with the `vault_read` / `vault_find` tools (see createVaultTools).
 *
 * Vaults are per task and short-lived: the API removes them after 24 h (sweepVaults).
 * The chat shows how many documents a running task has in its vault (progress.ts).
 */
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HydraTool } from './types.js';
import { redactSecrets } from './guard.js';
import { progressRef } from './progress.js';

/** Results up to this size are handed to the model as they are. */
export const VAULT_MIN_CHARS = 2_500;
/** What the model sees of a stored result before the index and the marker. */
export const DIGEST_HEAD_CHARS = 1_500;
/** Longest window one vault_read returns; the rest is reached with `from`. */
export const READ_WINDOW_CHARS = 6_000;
/** Above this a tool result is cut even for the vault (a runaway page, a binary dump). */
export const VAULT_MAX_CHARS = 300_000;
const MAX_SECTIONS = 24;
const MAX_FIND_HITS = 12;
const FIND_CONTEXT = 160;
const MAX_DOCS = 200;
export const VAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface VaultEntry {
  n: number;
  tool: string;
  /** What the call was about (the page, the query, the repo), as shown in progress. */
  ref?: string;
  chars: number;
  sections: string[];
  at: string;
}

export interface VaultSummary {
  docs: number;
  chars: number;
  /** Findings the agent wrote down with vault_note. */
  notes?: number;
  /** Tool results replaced by a stub in the conversation because the budget was hit. */
  compactions?: number;
}

/** What prepareStep hands over and takes back (the AI SDK's own types stay out of this package). */
export interface StepMessages {
  messages: unknown[];
  initialInstructions?: unknown;
}
export interface StepOverrides {
  messages?: unknown[];
  system?: string;
}

export interface TaskVault {
  /** Returns what the model should get for this result: the result itself, or a digest. */
  store(toolName: string, args: unknown, result: unknown): Promise<unknown>;
  read(n: number, opts?: { section?: string; from?: number }): Promise<string>;
  find(query: string, n?: number): Promise<string>;
  /** A finding worth keeping (vault_note): persisted, and repeated to the model on every step. */
  note(text: string): Promise<string>;
  notes(): string[];
  /** Brings in another task's vault (the plan this task carries out): its documents keep their numbers. */
  importFrom(dir: string): Promise<number>;
  /** For the system prompt: the documents already in the vault and the notes so far ('' when empty). */
  promptSection(): string;
  /**
   * The AI SDK `prepareStep` hook: before each model call, tool results older than the last
   * rounds are replaced by a stub once they exceed the budget (they stay in the vault), and
   * the notes ride along in the system prompt.
   */
  prepareStep(step: StepMessages): StepOverrides | undefined;
  list(): VaultEntry[];
  summary(): VaultSummary;
}

export interface TaskVaultOptions {
  /** `storage/results/<task>/vault` */
  dir: string;
  /** Called after each stored document (the worker feeds the chat's counter). */
  onChange?: (summary: VaultSummary) => void;
  /** How much tool-result text may travel in the conversation before older results are compacted. */
  budgetChars?: number;
}

/**
 * The budget for one task's tool results in context: ~22k tokens for an API model, less
 * for a local one (small windows), overridable with HYDRA_TOOL_CONTEXT_CHARS.
 */
export function vaultBudgetChars(provider?: string): number {
  const env = Number(process.env.HYDRA_TOOL_CONTEXT_CHARS);
  if (env > 0) return env;
  return provider === 'local' ? 40_000 : 90_000;
}
const KEEP_ROUNDS = 2;
const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 600;
const STUB_MARK = '· compacted:';

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
};

const kb = (chars: number) => `${Math.max(1, Math.round(chars / 1024))} KB`;

/**
 * The headings of a document, for the digest's index and for reading by section:
 * Markdown headings (what fetch_url produces), or the top-level keys of a JSON object.
 */
export function detectSections(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) { if (out.length >= MAX_SECTIONS) break; out.push(k); }
        return out;
      }
    } catch { /* not JSON: fall through to headings */ }
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i);
    if (!h) continue;
    const title = h.title.replace(/\s+/g, ' ').trim();
    if (!title || out.includes(title)) continue;
    out.push(title.length > 80 ? title.slice(0, 79) + '…' : title);
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

/**
 * A Markdown heading starting at line `i`: ATX (`## Title`) or setext (a title line
 * underlined with `===` or `---`, which is how turndown writes h1/h2 for web pages).
 */
function headingAt(lines: string[], i: number): { level: number; title: string; lines: number } | null {
  const atx = atxHeading(lines[i]);
  if (atx) return { ...atx, lines: 1 };
  const under = (lines[i + 1] ?? '').trim();
  const isRule = under.length >= 3 && (under === '='.repeat(under.length) || under === '-'.repeat(under.length));
  if (isRule && lines[i].trim() && !/^[\s>*+-]|^\d+\./.test(lines[i])) {
    return { level: under[0] === '=' ? 1 : 2, title: lines[i], lines: 2 };
  }
  return null;
}

/** `## Title ##` → level 2, "Title". Parsed by hand: a regex here is polynomial on long runs of spaces. */
function atxHeading(line: string): { level: number; title: string } | null {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  if (level === 0 || level > 6 || (line[level] !== ' ' && line[level] !== '\t')) return null;
  let title = line.slice(level + 1).trim();
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end--;
  title = title.slice(0, end).trim();
  return title ? { level, title } : null;
}

/** Cuts at the last line break before `max`, so the head does not end mid-word. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max / 2 ? cut : max);
}

/** The text of one section: from its heading to the next heading of the same or a higher level. */
function sectionText(text: string, wanted: string): string | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const key = Object.keys(obj).find((k) => k.toLowerCase() === needle) ?? Object.keys(obj).find((k) => k.toLowerCase().includes(needle));
        return key ? toText(obj[key]) : null;
      }
    } catch { /* not JSON */ }
  }
  const lines = text.split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i);
    if (!h) continue;
    if (start < 0) {
      const title = h.title.trim().toLowerCase();
      if (title === needle || title.includes(needle)) { start = i; level = h.level; }
    } else if (h.level <= level) {
      return lines.slice(start, i).join('\n');
    }
    i += h.lines - 1;
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/** The text of a tool-result part as the model sees it (AI SDK: `output.value` text or JSON). */
function toolResultText(part: any): string | null {
  if (!part || part.type !== 'tool-result') return null;
  const out = part.output;
  if (out && typeof out === 'object' && 'value' in out) return typeof out.value === 'string' ? out.value : toText(out.value);
  if (typeof part.result === 'string') return part.result;
  return part.result === undefined ? null : toText(part.result);
}

function withToolResultText(part: any, text: string): any {
  if (part.output && typeof part.output === 'object' && 'value' in part.output) return { ...part, output: { ...part.output, type: 'text', value: text } };
  return { ...part, result: text };
}

/**
 * Replaces the oldest vaulted tool results in `messages` with a one-line stub until the
 * text of all tool results fits `budgetChars`; the last KEEP_ROUNDS tool messages are left
 * alone. Only results that carry a `[vault #n` marker are touched: they are on disk and
 * vault_read brings them back. Returns the new list and the numbers compacted this time.
 */
export function compactToolMessages(messages: unknown[], budgetChars: number, entryOf: (n: number) => VaultEntry | undefined): { messages: unknown[]; compacted: number[] } {
  const msgs = messages as any[];
  const toolIdx = msgs.map((m, i) => (m?.role === 'tool' && Array.isArray(m.content) ? i : -1)).filter((i) => i >= 0);
  const out = [...msgs];
  const size = () => out.reduce((n, m) => (m?.role === 'tool' && Array.isArray(m.content) ? n + m.content.reduce((k: number, p: any) => k + (toolResultText(p)?.length ?? 0), 0) : n), 0);
  const compacted: number[] = [];
  if (size() <= budgetChars) return { messages, compacted };
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_ROUNDS));
  for (const i of candidates) {
    if (size() <= budgetChars) break;
    const m = out[i];
    const content = m.content.map((p: any) => {
      const text = toolResultText(p);
      const mark = text ? /\[vault #(\d+) · /.exec(text) : null;
      if (!mark || text!.includes(STUB_MARK) || text!.length < 400) return p;
      const n = Number(mark[1]);
      const e = entryOf(n);
      compacted.push(n);
      const label = e ? `${e.tool}${e.ref ? ` · ${e.ref}` : ''} · ${kb(e.chars)}` : 'stored result';
      return withToolResultText(p, `[vault #${n} · ${label} ${STUB_MARK} the text was removed from this conversation to save room; it is still in the vault. Do not fetch it again: vault_read(n=${n}) or vault_find(query, n=${n}) bring it back.]`);
    });
    out[i] = { ...m, content };
  }
  return { messages: out, compacted };
}

export function createTaskVault(options: TaskVaultOptions): TaskVault {
  const entries: VaultEntry[] = [];
  const cache = new Map<number, string>();
  const notes: string[] = [];
  let nextN = 1;
  // Documents compacted so far: the SDK rebuilds the messages from the steps before each
  // call, so the same result is stubbed again every step; it counts (and logs) once.
  const compacted = new Set<number>();
  let imported = 0;
  let ready: Promise<void> | null = null;
  const ensureDir = () => (ready ??= mkdir(options.dir, { recursive: true }).then(() => undefined));
  const file = (n: number) => path.join(options.dir, `${n}.txt`);
  const summary = (): VaultSummary => ({
    docs: entries.length,
    chars: entries.reduce((a, e) => a + e.chars, 0),
    ...(notes.length ? { notes: notes.length } : {}),
    ...(compacted.size ? { compactions: compacted.size } : {}),
  });
  const saveIndex = () => writeFile(path.join(options.dir, 'index.json'), JSON.stringify({ entries }, null, 2), 'utf-8').catch(() => {});
  const saveNotes = () => writeFile(path.join(options.dir, 'notes.md'), notes.map((n, i) => `${i + 1}. ${n}`).join('\n') + '\n', 'utf-8').catch(() => {});
  const changed = () => { try { options.onChange?.(summary()); } catch { /* the counter never breaks a call */ } };

  const load = async (n: number): Promise<string | null> => {
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    if (!entries.some((e) => e.n === n)) return null;
    try {
      const text = await readFile(file(n), 'utf-8');
      cache.set(n, text);
      return text;
    } catch { return null; }
  };

  const digest = (entry: VaultEntry, text: string): string => {
    const index = entry.sections.length
      ? `\n\n[sections: ${entry.sections.map((s) => `"${s}"`).join(', ')}]`
      : '';
    return (
      head(text, DIGEST_HEAD_CHARS) +
      `\n…${index}\n[vault #${entry.n} · ${kb(entry.chars)} · this is the beginning of the ${entry.tool} result; ` +
      `the whole text is kept. vault_read(n=${entry.n}) continues from here, vault_read(n=${entry.n}, section="…") opens one section, ` +
      `vault_find(query="…", n=${entry.n}) searches it.]`
    );
  };

  const promptSectionOf = (): string => {
    const parts: string[] = [];
    if (imported) {
      const docs = entries.map((e) => `#${e.n} ${e.tool}${e.ref ? ` (${e.ref})` : ''}, ${kb(e.chars)}${e.sections.length ? `, sections: ${e.sections.slice(0, 8).map((s) => `"${s}"`).join(', ')}` : ''}`);
      parts.push(
        `Documents already in this task's vault, read earlier (while planning, or before an approval):\n${docs.map((d) => `- ${d}`).join('\n')}\n` +
        `Any plan step that says to open, fetch or read these pages is already done: do not fetch them again, use vault_read(n=…) or vault_find on them.`,
      );
    }
    if (notes.length) parts.push(`Your notes so far (vault_note):\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`);
    return parts.length ? `\n\n## Task vault\n${parts.join('\n\n')}` : '';
  };

  return {
    async store(toolName, args, result) {
      // The vault tools read the vault; storing their output would loop.
      if (toolName.startsWith('vault_') || result == null) return result;
      let text = toText(result);
      if (text.length <= VAULT_MIN_CHARS || entries.length >= MAX_DOCS) return result;
      if (text.length > VAULT_MAX_CHARS) text = text.slice(0, VAULT_MAX_CHARS) + `\n[cut at ${VAULT_MAX_CHARS} characters]`;
      // Tools run in parallel: the number is taken synchronously, before any await, so
      // three pages fetched at once get #1, #2 and #3 and not the same file.
      const entry: VaultEntry = {
        n: nextN++,
        tool: toolName,
        ref: progressRef(toolName, args),
        chars: text.length,
        sections: detectSections(text),
        at: new Date().toISOString(),
      };
      entries.push(entry);
      cache.set(entry.n, text);
      try {
        await ensureDir();
        await writeFile(file(entry.n), text, 'utf-8');
      } catch (err) {
        // Disk trouble must not cost the task its result: the model gets the old-style cut.
        console.warn(`[vault] could not store the ${toolName} result`, err);
        entries.splice(entries.indexOf(entry), 1);
        cache.delete(entry.n);
        return head(text, VAULT_MIN_CHARS) + `\n[result cut at ${VAULT_MIN_CHARS} characters: the vault is not available]`;
      }
      saveIndex();
      changed();
      return digest(entry, text);
    },

    async note(text) {
      const clean = redactSecrets(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, MAX_NOTE_CHARS);
      if (!clean) return 'Nothing to note: give the finding as text.';
      if (notes.length >= MAX_NOTES) return `The note list is full (${MAX_NOTES}); fold this into an existing one when you answer.`;
      notes.push(clean);
      try { await ensureDir(); await saveNotes(); } catch { /* the note still lives in memory for this task */ }
      changed();
      return `Noted (#${notes.length}). Your notes are shown to you on every step.`;
    },
    notes: () => [...notes],

    async importFrom(dir) {
      let index: { entries?: VaultEntry[] };
      try { index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf-8')); } catch { return 0; }
      let count = 0;
      for (const e of index.entries ?? []) {
        if (!e || typeof e.n !== 'number' || entries.some((x) => x.n === e.n)) continue;
        try {
          const text = await readFile(path.join(dir, `${e.n}.txt`), 'utf-8');
          await ensureDir();
          await writeFile(file(e.n), text, 'utf-8');
          entries.push({ ...e, sections: [...(e.sections ?? [])] });
          cache.set(e.n, text);
          count++;
        } catch { /* a missing file is skipped */ }
      }
      try {
        const md = await readFile(path.join(dir, 'notes.md'), 'utf-8');
        for (const line of md.split('\n')) { const m = /^\d+\.\s+(.+)$/.exec(line); if (m && notes.length < MAX_NOTES) notes.push(m[1]); }
      } catch { /* no notes there */ }
      if (count) {
        entries.sort((a, b) => a.n - b.n);
        nextN = Math.max(nextN, ...entries.map((e) => e.n + 1));
        imported += count;
        saveIndex();
        if (notes.length) saveNotes();
        changed();
      }
      return count;
    },

    promptSection: () => promptSectionOf(),

    prepareStep(step) {
      const budget = options.budgetChars ?? vaultBudgetChars();
      const { messages, compacted: now } = compactToolMessages(step.messages, budget, (n) => entries.find((e) => e.n === n));
      const fresh = now.filter((n) => !compacted.has(n));
      if (fresh.length) {
        for (const n of fresh) compacted.add(n);
        console.log(`[vault] compacted ${fresh.length} tool result(s) (#${fresh.join(', #')}) to stay under ${budget} characters`);
        changed();
      }
      const section = promptSectionOf();
      const base = typeof step.initialInstructions === 'string' ? step.initialInstructions : undefined;
      const out: StepOverrides = {};
      if (now.length) out.messages = messages;
      if (section && base !== undefined) out.system = base + section;
      return out.messages || out.system ? out : undefined;
    },

    async read(n, opts = {}) {
      const text = await load(n);
      const entry = entries.find((e) => e.n === n);
      if (text === null || !entry) return `There is no document #${n} in the vault. Stored: ${entries.map((e) => `#${e.n} ${e.tool}${e.ref ? ` (${e.ref})` : ''}`).join(', ') || 'none'}.`;
      if (opts.section) {
        const part = sectionText(text, opts.section);
        if (part === null) return `Document #${n} has no section matching "${opts.section}". Sections: ${entry.sections.map((s) => `"${s}"`).join(', ') || 'none detected'}.`;
        if (part.length <= READ_WINDOW_CHARS) return part;
        return part.slice(0, READ_WINDOW_CHARS) + `\n[section continues: ${part.length - READ_WINDOW_CHARS} more characters; read it with from=… on the whole document]`;
      }
      const from = Math.max(0, Math.min(Math.floor(opts.from ?? DIGEST_HEAD_CHARS), text.length));
      const window = text.slice(from, from + READ_WINDOW_CHARS);
      const end = from + window.length;
      const tail = end < text.length ? `\n[vault #${n}: characters ${from}–${end} of ${text.length}; continue with from=${end}]` : `\n[vault #${n}: end of document (${text.length} characters)]`;
      return window + tail;
    },

    async find(query, n) {
      const q = query.trim().toLowerCase();
      if (!q) return 'Give one or more words to search for.';
      const targets = n ? entries.filter((e) => e.n === n) : entries;
      if (!targets.length) return n ? `There is no document #${n} in the vault.` : 'The vault is empty.';
      const hits: string[] = [];
      for (const entry of targets) {
        const text = await load(entry.n);
        if (text === null) continue;
        const lower = text.toLowerCase();
        let at = lower.indexOf(q);
        let perDoc = 0;
        while (at >= 0 && hits.length < MAX_FIND_HITS && perDoc < 4) {
          const s = Math.max(0, at - FIND_CONTEXT), e = Math.min(text.length, at + q.length + FIND_CONTEXT);
          hits.push(`#${entry.n} @${at}: …${text.slice(s, e).replace(/\s+/g, ' ')}…`);
          perDoc++;
          at = lower.indexOf(q, at + q.length);
        }
        if (hits.length >= MAX_FIND_HITS) break;
      }
      if (!hits.length) return `"${query}" appears in none of the ${targets.length} document(s) searched.`;
      return `${hits.length} match(es) for "${query}" (position after @ can be used as from= in vault_read):\n` + hits.join('\n');
    },

    list: () => entries.map((e) => ({ ...e, sections: [...e.sections] })),
    summary,
  };
}

/**
 * The two tools the model gets while a task has a vault. They are appended by the
 * registry (not gated by tools.md: they only reach what this task's own tools already
 * brought in) and marked as reading outside content, so what they return is wrapped
 * as data like the original result was.
 */
export function createVaultTools(vault: TaskVault): HydraTool[] {
  return [
    {
      name: 'vault_read',
      title: 'Vault: read',
      risk: { readsExternal: true },
      description:
        'Reads more of a long tool result kept in the task vault (marked [vault #n] in the result you got). ' +
        'With `section`, returns that section (as listed in the marker); otherwise returns up to 6000 characters starting at `from` (default: right after the part you already saw).',
      schema: z.object({
        n: z.number().int().positive().describe('The document number from the [vault #n] marker'),
        section: z.string().optional().describe('A section title (or part of it) from the marker'),
        from: z.number().int().nonnegative().optional().describe('Character offset to continue from'),
      }),
      execute: async ({ n, section, from }) => redactSecrets(await vault.read(n, { section, from })),
    },
    {
      name: 'vault_find',
      title: 'Vault: find',
      risk: { readsExternal: true },
      description:
        'Searches the long tool results kept in the task vault for a word or phrase and returns each match with its surroundings. ' +
        'Give `n` to search one document, or leave it out to search all of them.',
      schema: z.object({
        query: z.string().min(1).describe('The word or phrase to look for (case-insensitive)'),
        n: z.number().int().positive().optional().describe('Restrict to one document number'),
      }),
      execute: async ({ query, n }) => redactSecrets(await vault.find(query, n)),
    },
    {
      name: 'vault_note',
      title: 'Vault: note',
      risk: { readsExternal: false, sensitive: false },
      description:
        'Writes down a finding worth keeping while you work: a figure, a quote, a conclusion, with the document number it comes from (e.g. "Cookie Clicker: released 8 Aug 2013 (#1, Reception)"). ' +
        'Long tool results may be removed from this conversation as it grows; your notes are shown to you on every step and survive, so note what you will need for the final answer.',
      schema: z.object({
        text: z.string().min(1).max(600).describe('One or two sentences; include the [vault #n] the fact comes from'),
      }),
      execute: async ({ text }) => vault.note(text),
    },
  ];
}

/**
 * Removes the vault folders older than `maxAgeMs` under `storage/results` (the
 * result.json next to them stays). Run by the API on start and every hour.
 */
export async function sweepVaults(resultsDir: string, maxAgeMs = VAULT_RETENTION_MS): Promise<number> {
  let removed = 0;
  let taskDirs: string[];
  try { taskDirs = await readdir(resultsDir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  for (const id of taskDirs) {
    const dir = path.join(resultsDir, id, 'vault');
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch { /* no vault here, or already gone */ }
  }
  return removed;
}

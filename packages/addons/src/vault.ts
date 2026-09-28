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
}

export interface TaskVault {
  /** Returns what the model should get for this result: the result itself, or a digest. */
  store(toolName: string, args: unknown, result: unknown): Promise<unknown>;
  read(n: number, opts?: { section?: string; from?: number }): Promise<string>;
  find(query: string, n?: number): Promise<string>;
  list(): VaultEntry[];
  summary(): VaultSummary;
}

export interface TaskVaultOptions {
  /** `storage/results/<task>/vault` */
  dir: string;
  /** Called after each stored document (the worker feeds the chat's counter). */
  onChange?: (summary: VaultSummary) => void;
}

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

export function createTaskVault(options: TaskVaultOptions): TaskVault {
  const entries: VaultEntry[] = [];
  const cache = new Map<number, string>();
  let ready: Promise<void> | null = null;
  const ensureDir = () => (ready ??= mkdir(options.dir, { recursive: true }).then(() => undefined));
  const file = (n: number) => path.join(options.dir, `${n}.txt`);
  const summary = (): VaultSummary => ({ docs: entries.length, chars: entries.reduce((a, e) => a + e.chars, 0) });

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

  return {
    async store(toolName, args, result) {
      // The vault tools read the vault; storing their output would loop.
      if (toolName.startsWith('vault_') || result == null) return result;
      let text = toText(result);
      if (text.length <= VAULT_MIN_CHARS || entries.length >= MAX_DOCS) return result;
      if (text.length > VAULT_MAX_CHARS) text = text.slice(0, VAULT_MAX_CHARS) + `\n[cut at ${VAULT_MAX_CHARS} characters]`;
      const entry: VaultEntry = {
        n: entries.length + 1,
        tool: toolName,
        ref: progressRef(toolName, args),
        chars: text.length,
        sections: detectSections(text),
        at: new Date().toISOString(),
      };
      try {
        await ensureDir();
        await writeFile(file(entry.n), text, 'utf-8');
      } catch (err) {
        // Disk trouble must not cost the task its result: the model gets the old-style cut.
        console.warn(`[vault] could not store the ${toolName} result`, err);
        return head(text, VAULT_MIN_CHARS) + `\n[result cut at ${VAULT_MIN_CHARS} characters: the vault is not available]`;
      }
      entries.push(entry);
      cache.set(entry.n, text);
      writeFile(path.join(options.dir, 'index.json'), JSON.stringify({ entries }, null, 2), 'utf-8').catch(() => {});
      try { options.onChange?.(summary()); } catch { /* the counter never breaks a call */ }
      return digest(entry, text);
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

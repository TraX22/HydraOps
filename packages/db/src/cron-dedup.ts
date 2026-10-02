/**
 * What a scheduled task already delivered, so a recurring "bring me the latest news"
 * reports only what is new.
 *
 * It used to be the text of the last three runs, handed to the model with "do not
 * repeat". Two runs that said "nothing new" pushed the real list out of that window
 * (and long lists were cut), so the next run delivered the same items again; and a
 * small model often repeated them even with the list in front of it.
 *
 * Now there is a record that does not forget because nothing happened, read from the
 * cron's previous runs:
 *  - the links of their answers (what was delivered), and
 *  - a digest of each page their tools read (what the sources said).
 * The model gets the delivered links up front, and its answer is then filtered BY CODE,
 * not by asking it again (a model asked to "remove the repeats" drops new items as
 * readily as old ones):
 *  - when every page read in this run said exactly what it said in an earlier run, the
 *    answer becomes one line: nothing new;
 *  - otherwise the items whose links were already delivered are removed, and what is
 *    left goes out. An item about a page that was read again and now says something
 *    else (a price, a status) is kept: same link, new content.
 * An item without a link, from sources that did change, cannot be told apart and goes
 * out as written.
 *
 * Scoped by cron id, not channel: each cron keeps its own record even when several
 * crons, or the interactive chat, share an agent's channel.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import * as schema from "./schema.js";

/** How many past runs feed the record, and how many links the model is shown. */
const LEDGER_RUNS = 60;
const LEDGER_LINKS_SHOWN = 150;
/** Previous answers quoted for context (titles, items without a link). */
const QUOTED_RUNS = 3;
const QUOTED_CHARS = 1500;
/** Shorter than this and without links, a text is a "nothing new" line, not content. */
const SUBSTANTIVE_CHARS = 260;

/** What the worker delivers when it cannot get the line in the user's language. */
export const CRON_NOTHING_NEW = "Nothing new since the last run.";

// Linear: one character class, no nested quantifiers.
const LINK_RE = /https?:\/\/[^\s<>"'`)\]|]+/g;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|source)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;
const TRAILING = ".,;:!?*_~";

function trimLink(raw: string): string {
  let text = raw.trim();
  while (text.length && TRAILING.includes(text[text.length - 1])) text = text.slice(0, -1);
  return text;
}

/**
 * The same page written in slightly different ways compares equal: scheme, "www.",
 * a trailing slash, tracking parameters, the fragment, and a leading language segment
 * ("/es/blog/post" and "/blog/post" are one post).
 */
export function normalizeLink(raw: string): string {
  const text = trimLink(raw);
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length > 1 && LOCALE_SEGMENT.test(segments[0])) segments.shift();
    return `${host}${segments.length ? "/" + segments.join("/") : ""}${query}`;
  } catch {
    return text.toLowerCase();
  }
}

/** The links in a text, each once (by what it points to), as written. */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of String(text ?? "").match(LINK_RE) ?? []) {
    const url = trimLink(hit);
    const key = normalizeLink(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export interface CronLedger {
  cronId: string;
  /** Normalized link → the link as it was delivered; most recent first. */
  delivered: Map<string, string>;
  /** Normalized link of a page that was read → the digests of what it said, run after run. */
  digests: Map<string, Set<string>>;
  /** Links named in the task itself (the feed, the page to read): never "an item". */
  promptLinks: Set<string>;
  /** The latest answers that had content, whole, most recent first. */
  answers: { when: string; text: string }[];
}

/** The record of the cron this task belongs to; null for a task that no cron fired. */
export async function loadCronLedger(db: any, taskId: string, opts: { maxRuns?: number } = {}): Promise<CronLedger | null> {
  const [current] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  const cronId = current?.cronId;
  if (!cronId) return null;

  const previous = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.cronId, cronId), eq(schema.tasks.status, "completed"), ne(schema.tasks.id, taskId)))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(opts.maxRuns ?? LEDGER_RUNS);

  const promptLinks = new Set(extractLinks(String(current.prompt ?? "")).map(normalizeLink));
  const delivered = new Map<string, string>();
  const digests = new Map<string, Set<string>>();
  const answers: CronLedger["answers"] = [];
  for (const t of previous) {
    for (const s of Array.isArray(t.resultMeta?.sources) ? t.resultMeta.sources : []) {
      if (typeof s?.url !== "string" || typeof s?.digest !== "string") continue;
      const key = normalizeLink(s.url);
      if (!digests.has(key)) digests.set(key, new Set());
      digests.get(key)!.add(s.digest);
    }
    const text = String(t.resultMeta?.text || t.resultMeta?.preview || "").trim();
    if (!text) continue;
    const links = extractLinks(text).filter((u) => !promptLinks.has(normalizeLink(u)));
    for (const u of links) {
      const key = normalizeLink(u);
      if (!delivered.has(key)) delivered.set(key, u);
    }
    if (answers.length < QUOTED_RUNS && isSubstantive(text, links.length)) {
      // completedAt when the worker stamped it; updatedAt only as a fallback for old rows.
      const finished = t.resultMeta?.completedAt ?? t.updatedAt;
      answers.push({ when: finished ? new Date(finished).toISOString() : "", text });
    }
  }
  return { cronId, delivered, digests, promptLinks, answers };
}

const isSubstantive = (text: string, itemLinks: number) => itemLinks > 0 || text.trim().length >= SUBSTANTIVE_CHARS;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text);

/**
 * The block the worker appends to the system prompt of a cron-fired task: the links
 * already delivered and the latest answers that had content. "" for a task no cron
 * fired, or a cron with nothing delivered yet.
 */
export async function buildCronDedupContext(db: any, taskId: string, opts: { maxRuns?: number } = {}): Promise<string> {
  const ledger = await loadCronLedger(db, taskId, opts);
  if (!ledger || (!ledger.delivered.size && !ledger.answers.length)) return "";
  const links = [...ledger.delivered.values()].slice(0, LEDGER_LINKS_SHOWN);
  return (
    `\n\n---\n[RECURRING TASK — AVOID REPEATS]\n` +
    `This exact task runs on a schedule. Report ONLY what is new since the earlier runs, and write every item with its own link (items already delivered are removed by their link). ` +
    `If nothing is new, answer with ONE short line saying so, in the user's language, and stop: do not list old items again.\n` +
    (links.length
      ? `\nLinks you already delivered in earlier runs (most recent first). An item whose link is in this list is NOT new, whatever its date:\n` +
        links.map((u) => `- ${u}`).join("\n") + "\n"
      : "") +
    (ledger.answers.length
      ? `\nWhat the latest runs with content said (most recent first):\n\n` +
        ledger.answers.map((q) => `--- Previous run ${q.when} ---\n${clip(q.text, QUOTED_CHARS)}`).join("\n\n")
      : "")
  );
}

// ── Filtering an answer ───────────────────────────────────────────────────────

// Where an item starts: a heading, a top-level bullet or number, a table row, or a line
// that is only bold text (a date or a section title). Indented lines belong to the item above.
function startsItem(line: string): boolean {
  if (!line || line[0] === " " || line[0] === "\t") return false;
  if (line[0] === "#" || line[0] === "|") return true;
  if ((line[0] === "-" || line[0] === "*" || line[0] === "•") && line[1] === " ") return true;
  let i = 0;
  while (i < line.length && line[i] >= "0" && line[i] <= "9") i++;
  if (i > 0 && i < 4 && (line[i] === "." || line[i] === ")") && line[i + 1] === " ") return true;
  const t = line.trim();
  return t.length > 4 && t.startsWith("**") && t.endsWith("**") && t.indexOf("**", 2) === t.length - 2;
}

/** A block that only announces what follows: a heading or a bold line, nothing else. */
function isHeaderOnly(block: string): boolean {
  const lines = block.split("\n").filter((l) => l.trim());
  if (lines.length !== 1) return false;
  const t = lines[0].trim();
  return t[0] === "#" || (t.startsWith("**") && t.endsWith("**"));
}

/** The answer as a preamble and its items (see startsItem). */
export function splitAnswerItems(answer: string): { preamble: string; items: string[] } {
  const lines = answer.split("\n");
  const first = lines.findIndex(startsItem);
  if (first < 0) return { preamble: answer, items: [] };
  const items: string[] = [];
  let cur: string[] = [];
  for (const line of lines.slice(first)) {
    if (startsItem(line) && cur.length) { items.push(cur.join("\n")); cur = []; }
    cur.push(line);
  }
  if (cur.length) items.push(cur.join("\n"));
  return { preamble: lines.slice(0, first).join("\n"), items };
}

export interface CronSourceRead { url: string; kind?: string; digest?: string }

export interface CronFilterResult {
  /** The answer to deliver, or null when nothing new is left (the worker delivers one line). */
  text: string | null;
  /** How many items were removed. */
  dropped: number;
  /** For the log. */
  reason: string;
}

/**
 * Filters the answer of a cron-fired task against what its earlier runs delivered.
 * `sources` is what this run's tools read (the task's source collector). Returns null
 * when the answer goes out as written: a task no cron fired, a first run, a one-line
 * answer, or nothing to remove.
 */
export async function filterCronAnswer(db: any, taskId: string, answer: string, sources: CronSourceRead[] = []): Promise<CronFilterResult | null> {
  const ledger = await loadCronLedger(db, taskId);
  if (!ledger || (!ledger.delivered.size && !ledger.answers.length)) return null;
  const itemLinks = (text: string) => extractLinks(text).filter((u) => !ledger.promptLinks.has(normalizeLink(u)));
  if (!isSubstantive(answer, itemLinks(answer).length)) return null;

  const reads = sources.filter((s) => s.kind === "read" && typeof s.digest === "string" && typeof s.url === "string");
  const saidBefore = (s: CronSourceRead) => ledger.digests.get(normalizeLink(s.url))?.has(s.digest!) === true;

  // 1. Every page read in this run said exactly what it said in an earlier run.
  if (ledger.answers.length && reads.length && reads.every(saidBefore)) {
    return { text: null, dropped: 0, reason: `the ${reads.length} page(s) read said the same as in an earlier run: nothing new` };
  }

  // 2. Remove the items whose links were all delivered already. A delivered page that was
  // read again and now says something else is not a repeat.
  const changedNow = new Set(reads.filter((s) => ledger.digests.has(normalizeLink(s.url)) && !saidBefore(s)).map((s) => normalizeLink(s.url)));
  const isRepeat = (url: string) => { const key = normalizeLink(url); return ledger.delivered.has(key) && !changedNow.has(key); };
  const { preamble, items } = splitAnswerItems(answer);
  let dropped = 0;
  let kept = items.filter((block) => {
    const links = itemLinks(block);
    const repeat = links.length > 0 && links.every(isRepeat);
    if (repeat) dropped++;
    return !repeat;
  });
  if (!dropped) return null;
  // A heading left with nothing under it goes too (twice: a date under a section title).
  const pruneHeaders = (blocks: string[]) => blocks.filter((block, i) => !(isHeaderOnly(block) && (i === blocks.length - 1 || isHeaderOnly(blocks[i + 1]))));
  kept = pruneHeaders(pruneHeaders(kept));

  const rest = kept.join("\n").trim();
  if (!isSubstantive(rest, itemLinks(rest).length)) {
    return { text: null, dropped, reason: `all ${dropped} item(s) were already delivered: nothing new` };
  }
  const text = [preamble.trim(), rest].filter(Boolean).join("\n\n");
  return { text, dropped, reason: `${dropped} item(s) already delivered were removed, ${kept.filter((b) => itemLinks(b).length).length} kept` };
}

/** What the worker asks the model for when nothing new is left: the one line, in the user's language. */
export function cronNothingNewPrompt(taskPrompt: string): string {
  return (
    `A task that runs on a schedule found nothing new since its last run. ` +
    `Reply with ONE short sentence that says so, in the same language as the task below. Reply with the sentence only.\n\n` +
    `--- Task ---\n${clip(String(taskPrompt ?? ""), 600)}`
  );
}

/**
 * What a scheduled task already delivered, so a recurring "bring me the latest news"
 * reports only what is new.
 *
 * It used to be the text of the last three runs, handed to the model with "do not
 * repeat". Two runs that said "nothing new" pushed the real list out of that window
 * (and long lists were cut), so the next run delivered the same items again; and a
 * small model often repeated them even with the list in front of it.
 *
 * Now there is a record that does not forget because nothing happened:
 *  - the links of the answers of the cron's previous runs (what was delivered), and
 *  - the links its tools saw in those runs (what the sources contained).
 * The model gets the delivered links up front. And the answer is checked: when it
 * repeats delivered links, cites links the sources had already shown, carries no links,
 * or comes from sources that showed nothing new, the model is asked once, in a small call
 * with the earlier answers beside its draft, to drop what was already delivered. The
 * model keeps the last word on purpose: a task that reads the same page every day
 * for a figure that changes (a price, a status) cites the same link each time and is
 * not a repeat.
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
/** Shorter than this and without links, an answer is a "nothing new" line, not content. */
const SUBSTANTIVE_CHARS = 260;
/** In the rewrite request: earlier answers to compare with, and how much of each. */
const REWRITE_RUNS = 3;
const REWRITE_CHARS = 2500;

// Linear: one character class, no nested quantifiers.
const LINK_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|source)$/i;
const TRAILING = ".,;:!?*_~";

function trimLink(raw: string): string {
  let text = raw.trim();
  while (text.length && TRAILING.includes(text[text.length - 1])) text = text.slice(0, -1);
  return text;
}

/** The same page written in slightly different ways compares equal. */
export function normalizeLink(raw: string): string {
  const text = trimLink(raw);
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    const pathname = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
    return `${host}${pathname === "/" ? "" : pathname}${query}`;
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
  /** Normalized links the tools saw in earlier runs (what the sources contained). */
  seen: Set<string>;
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
  const seen = new Set<string>();
  const answers: CronLedger["answers"] = [];
  for (const t of previous) {
    for (const u of Array.isArray(t.resultMeta?.seenUrls) ? t.resultMeta.seenUrls : []) if (typeof u === "string") seen.add(normalizeLink(u));
    const text = String(t.resultMeta?.text || t.resultMeta?.preview || "").trim();
    if (!text) continue;
    const links = extractLinks(text).filter((u) => !promptLinks.has(normalizeLink(u)));
    for (const u of links) {
      const key = normalizeLink(u);
      if (!delivered.has(key)) delivered.set(key, u);
    }
    if (answers.length < Math.max(QUOTED_RUNS, REWRITE_RUNS) && isSubstantive(text, links.length)) {
      // completedAt when the worker stamped it; updatedAt only as a fallback for old rows.
      const finished = t.resultMeta?.completedAt ?? t.updatedAt;
      answers.push({ when: finished ? new Date(finished).toISOString() : "", text });
    }
  }
  return { cronId, delivered, seen, promptLinks, answers };
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
  const quoted = ledger.answers.slice(0, QUOTED_RUNS);
  return (
    `\n\n---\n[RECURRING TASK — AVOID REPEATS]\n` +
    `This exact task runs on a schedule. Report ONLY what is new since the earlier runs, and give each item with its link. ` +
    `If nothing is new, answer with ONE short line saying so, in the user's language, and stop: do not list old items again.\n` +
    (links.length
      ? `\nLinks you already delivered in earlier runs (most recent first). An item whose link is in this list is NOT new, whatever its date:\n` +
        links.map((u) => `- ${u}`).join("\n") + "\n"
      : "") +
    (quoted.length
      ? `\nWhat the latest runs with content said (most recent first):\n\n` +
        quoted.map((q) => `--- Previous run ${q.when} ---\n${clip(q.text, QUOTED_CHARS)}`).join("\n\n")
      : "")
  );
}

export interface CronRepeatCheck {
  /** Links of the answer that earlier runs already delivered (as written in the answer). */
  repeated: string[];
  /** Links of the answer that the sources had already shown in earlier runs, though no answer carried them. */
  seenBefore: string[];
  /** Links the tools saw in this run for the first time: what is new in the sources. */
  newInSources: string[];
  /** The tools saw, this run, no link that earlier runs had not seen: the sources brought nothing new. */
  sourcesUnchanged: boolean;
  /** Earlier answers with content, to compare the draft with (most recent first). */
  previous: { when: string; text: string }[];
}

const NEW_LINKS_SHOWN = 40;

/**
 * Should this answer of a cron-fired task be looked at again before it is delivered?
 * Yes when it has content and any of these holds: it repeats delivered links; it cites
 * links the sources had already shown in earlier runs; the sources showed nothing new;
 * or it carries no links at all, so only its words can be compared. An answer whose
 * every link is new to this cron goes out as it is. `seenNow` is what the task's tools
 * saw in this run. Returns null when there is nothing to do (also for a task no cron
 * fired, a first run, and a one-line "nothing new").
 */
export async function cronRepeatCheck(db: any, taskId: string, answer: string, seenNow: string[] = []): Promise<CronRepeatCheck | null> {
  const ledger = await loadCronLedger(db, taskId);
  if (!ledger || (!ledger.delivered.size && !ledger.answers.length)) return null;
  const links = extractLinks(answer).filter((u) => !ledger.promptLinks.has(normalizeLink(u)));
  if (!isSubstantive(answer, links.length)) return null;
  const known = (key: string) => ledger.seen.has(key) || ledger.delivered.has(key);
  const repeated = links.filter((u) => ledger.delivered.has(normalizeLink(u)));
  const seenBefore = links.filter((u) => !ledger.delivered.has(normalizeLink(u)) && ledger.seen.has(normalizeLink(u)));
  const now = extractLinks(seenNow.join("\n")).filter((u) => !ledger.promptLinks.has(normalizeLink(u)));
  const newInSources = now.filter((u) => !known(normalizeLink(u)));
  const sourcesUnchanged = ledger.seen.size > 0 && now.length > 0 && newInSources.length === 0;
  // Content without a single link, from sources that were read: only the words can tell.
  const unverifiable = links.length === 0 && now.length > 0 && ledger.answers.length > 0;
  if (!repeated.length && !seenBefore.length && !sourcesUnchanged && !unverifiable) return null;
  return { repeated, seenBefore, newInSources: newInSources.slice(0, NEW_LINKS_SHOWN), sourcesUnchanged, previous: ledger.answers.slice(0, REWRITE_RUNS) };
}

/** What the worker asks the model when the check fires: the same answer without what was already delivered. */
export function cronRewritePrompt(draft: string, check: CronRepeatCheck): string {
  const list = (urls: string[]) => urls.map((u) => `- ${u}`).join("\n");
  return (
    `You wrote the draft below for a task that runs on a schedule. It may repeat what earlier runs already delivered to the user.\n\n` +
    (check.repeated.length ? `These links of your draft were already delivered in earlier runs:\n${list(check.repeated)}\n\n` : "") +
    (check.seenBefore.length
      ? `These links of your draft were already in the sources when the earlier runs read them, so they are not new there; check below whether you already delivered those items:\n${list(check.seenBefore)}\n\n`
      : "") +
    (check.sourcesUnchanged
      ? `The pages you read in this run showed no link that earlier runs had not already seen: the sources brought nothing new.\n\n`
      : check.newInSources.length
        ? `Links the sources showed in this run for the first time (what is new there):\n${list(check.newInSources)}\n\n`
        : "") +
    (check.previous.length
      ? `What you delivered in earlier runs (most recent first):\n\n` +
        check.previous.map((p) => `--- Earlier run ${p.when} ---\n${clip(p.text, REWRITE_CHARS)}`).join("\n\n") + "\n\n"
      : "") +
    `Rewrite the draft in the same language and format:\n` +
    `- Remove every item that says the same as something already delivered, even if it is worded, dated or translated differently.\n` +
    `- Keep, exactly as written, the items that are new, and the ones whose facts changed since the earlier run (a new figure, a new state).\n` +
    `- Keep any note about a problem (a source that could not be read, a tool that failed).\n` +
    `- Do not add items, and do not mention this instruction or what you removed.\n` +
    `- If nothing is left, answer with one short line saying there is nothing new since the last run.\n\n` +
    `--- Draft ---\n${draft}`
  );
}

/**
 * A scheduled task that names its sources ("read these feeds…") has to open them.
 *
 * A model that sees what earlier runs delivered (buildCronDedupContext) can answer by
 * rewriting that, without calling a single tool: the answer looks like a digest, with
 * links it made up and feeds it says "could not be read" that it never tried. The
 * worker checks, after the call, whether the run opened ANY of the links the task names;
 * when none was opened it asks once more, and if the second answer did not open them
 * either, the run is delivered as a failure, never as news.
 *
 * Opening at least one is enough: a feed that is down is a normal day, and the answer
 * says so. Only a cron-fired task is checked; a chat message that pastes links is not.
 */
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { extractLinks, normalizeLink } from "./cron-dedup.js";

/** The error code the chat translates (llm.errors.cron_sources_unread). */
export const CRON_SOURCES_UNREAD = "cron_sources_unread";

export interface CronSourceUse { url: string; kind?: string }

/**
 * The links a cron-fired task names, when this run opened none of them; null when there
 * is nothing to ask for (not a cron-fired task, a task that names no link, or a run that
 * opened at least one).
 */
export async function cronUnreadSources(db: any, taskId: string, sources: CronSourceUse[] = []): Promise<string[] | null> {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  if (!task?.cronId) return null;
  const named = extractLinks(String(task.prompt ?? ""));
  if (!named.length) return null;
  const opened = new Set(sources.filter((s) => s.kind === "read" && typeof s.url === "string").map((s) => normalizeLink(s.url)));
  return named.some((u) => opened.has(normalizeLink(u))) ? null : named;
}

/** The second request, when the first answer opened none of the sources. */
export function cronReadSourcesPrompt(unread: string[]): string {
  return (
    `You answered without opening any of the sources this scheduled task names. ` +
    `Open them now with your tools (fetch_url), then write the answer only from what they returned. ` +
    `Do not reuse or rewrite an earlier answer, and do not say a source could not be read unless you tried it in this run.\n\n` +
    `Sources:\n${unread.map((u) => `- ${u}`).join("\n")}`
  );
}

/** What is delivered when the second answer did not open them either (the chat shows it translated). */
export const CRON_SOURCES_UNREAD_TEXT =
  "The scheduled task did not open its sources this time, so nothing was delivered: an answer written without reading them could be made up. It will try again at its next run.";

/** Two runs' token usage added up, field by field (the retry costs too). */
export function addUsage(a: any, b: any): any {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = typeof v === "number" && typeof a[k] === "number" ? a[k] + v : (a[k] ?? v);
  return out;
}

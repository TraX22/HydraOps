import * as sqliteSchema from "./schema.js";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const schema = sqliteSchema;

export const tasks = schema.tasks as any;
export const events = schema.events as any;
export const outbox = schema.outbox as any;
export const processedEvents = schema.processedEvents as any;
export const agentConfigs = schema.agentConfigs as any;
export const systemConfigs = schema.systemConfigs as any;
export const cronJobs = schema.cronJobs as any;
export const workerStatus = schema.workerStatus as any;
export const toolUsage = schema.toolUsage as any;

export * from "./client.js";
export * from "./recall.js";

/**
 * Persist a batch of tool invocations for one agent/task. Called by the workers
 * after an LLM turn with the events collected by the usage sink. Best-effort:
 * tracking must never break task processing, so callers wrap this in try/catch.
 */
export async function recordToolUsage(
  db: any,
  agentId: string,
  taskId: string | null,
  events: { toolName: string; source: string; status: string }[],
): Promise<void> {
  if (!events.length) return;
  const now = new Date();
  const rows = events.map((e) => ({
    agentId,
    taskId,
    toolName: e.toolName,
    source: e.source,
    status: e.status,
    createdAt: now,
  }));
  await db.insert(schema.toolUsage).values(rows).run();
}

/**
 * Build a "don't repeat yourself" block for a cron-fired task. Given the task's
 * id, it finds the originating cron and gathers what the previous runs of THAT
 * cron already delivered (their result text), then returns an instruction the
 * worker appends to the system prompt so a recurring task ("bring me the latest
 * news") reports only what is new instead of the same top items every time.
 *
 * Scoped by cron id, not channel, so each cron's memory stays isolated even when
 * several crons (or the interactive chat) share one agent's channel. Returns ""
 * for non-cron tasks or when there is nothing prior to dedup against.
 */
export async function buildCronDedupContext(
  db: any,
  taskId: string,
  opts: { maxRuns?: number; maxChars?: number } = {},
): Promise<string> {
  const maxRuns = opts.maxRuns ?? 3;
  const maxChars = opts.maxChars ?? 1500;
  const [current] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  const cronId = current?.cronId;
  if (!cronId) return "";

  const previous = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.cronId, cronId), eq(schema.tasks.status, "completed"), ne(schema.tasks.id, taskId)))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(maxRuns);

  const blocks = previous
    .map((t: any) => {
      const raw = (t.resultMeta?.text || t.resultMeta?.preview || "").trim();
      if (!raw) return "";
      const when = t.updatedAt ? new Date(t.updatedAt).toISOString() : "";
      const clip = raw.length > maxChars ? raw.slice(0, maxChars) + "…" : raw;
      return `--- Previous run ${when} ---\n${clip}`;
    })
    .filter(Boolean);
  if (!blocks.length) return "";

  return (
    `\n\n---\n[RECURRING TASK — AVOID REPEATS]\n` +
    `This exact task runs on a schedule. Below is what you already delivered in previous runs (most recent first). ` +
    `Do NOT repeat items, headlines, or links already listed; report ONLY what is genuinely new since then. ` +
    `If nothing is new, say so briefly instead of repeating.\n\n` +
    blocks.join("\n\n")
  );
}

/**
 * Load the channel's recent completed tasks for the workers' conversation
 * history, oldest last. Two guards keep stale context from derailing a run:
 *
 * - A cron-fired task gets NO chat history at all. Its prompt is self-contained
 *   and its prior-run context comes from buildCronDedupContext; feeding it the
 *   channel's chat can make a model re-execute an old imperative message
 *   ("remember that...") instead of the scheduled instruction.
 * - Interactive tasks only see the last 24 hours (same window the chat UI
 *   shows), so a days-old request no longer resurfaces as if it were live.
 */
export async function loadRecentChannelHistory(
  db: any,
  channel: string,
  taskId: string,
  opts: { hours?: number; limit?: number } = {},
): Promise<any[]> {
  const hours = opts.hours ?? 24;
  const limit = opts.limit ?? 10;
  const [current] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  if (current?.cronId) return [];

  const cutoff = new Date(Date.now() - hours * 3_600_000);
  return db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.channel, channel),
      eq(schema.tasks.status, "completed"),
      gte(schema.tasks.createdAt, cutoff),
      ne(schema.tasks.id, taskId),
    ))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(limit);
}

/**
 * Delete tool_usage rows older than the retention window (default 60 days, so a
 * user working in month N still sees month N-1's stats). Best-effort maintenance
 * called on a schedule; returns how many rows were removed. Callers wrap this in
 * try/catch — pruning must never break the API.
 */
export async function purgeOldToolUsage(
  db: any,
  retentionDays = 60,
): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result: any = await db
    .delete(schema.toolUsage)
    .where(lt(schema.toolUsage.createdAt, cutoff))
    .run();
  return Number(result?.changes ?? result?.rowCount ?? 0);
}

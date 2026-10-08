import * as sqliteSchema from "./schema.js";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
export const securityEvents = schema.securityEvents as any;
export const pendingActions = schema.pendingActions as any;

export * from "./client.js";
export * from "./recall.js";

/**
 * Persist a batch of tool invocations for one agent/task. Called by the workers
 * after an LLM turn with the events collected by the usage sink. Best-effort:
 * tracking must never break task processing, so callers wrap this in try/catch.
 */
/** True when the user cancelled this task (the API sets the status; workers must not overwrite it). */
export async function isTaskCancelled(db: any, taskId: string): Promise<boolean> {
  const rows = await db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  return rows[0]?.status === "cancelled";
}

/** The tools the latest completed task of a chat called (preloaded for the next task of that chat). */
export async function lastTaskToolNames(db: any, channel: string): Promise<string[]> {
  const [last] = await db.select({ id: schema.tasks.id }).from(schema.tasks)
    .where(and(eq(schema.tasks.channel, channel), eq(schema.tasks.status, "completed")))
    .orderBy(desc(schema.tasks.createdAt)).limit(1);
  if (!last) return [];
  const rows = await db.select({ toolName: schema.toolUsage.toolName }).from(schema.toolUsage).where(eq(schema.toolUsage.taskId, last.id));
  return [...new Set(rows.map((r: any) => String(r.toolName)))];
}

/**
 * The chain reached its limit: the decided calls ran, but no agent will report them. A
 * completed task (no worker, no model) tells the chat what happened and how to go on; the
 * UI renders it through llm.errors.continuation_limit with the outcomes as the reason.
 */
async function continuationLimitNotice(db: any, original: any, actions: any[], producer: string): Promise<string | null> {
  const decided = actions.filter((a: any) => a.status === "executed" || a.status === "failed");
  const outcomes = decided.map((a: any) => {
    const result = typeof a.result === "string" ? a.result.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    return `${a.toolName} ${a.status === "executed" ? "✓" : "✗"}${result ? `: ${result}` : ""}`;
  }).join(" · ");
  const text = `ℹ️ This task already chained ${CONTINUATION_MAX_DEPTH} continuations after your decisions, so the agent is not called again. The decided calls did run: ${outcomes || "none"}. To go on, send a new message.`;
  const taskId = randomUUID();
  const now = new Date();
  await db.insert(schema.tasks).values({
    id: taskId,
    prompt: `Decision outcome: ${decided.map((a: any) => `${a.toolName} ${a.status === "executed" ? "✓" : "✗"}`).join(", ")}`,
    channel: original.channel, status: "completed", isRead: original.isRead ?? true,
    continuationOf: original.id, createdAt: now, updatedAt: now,
    resultMeta: { text, success: true, errorCode: CONTINUATION_LIMIT, error: outcomes || "none", modelUsed: "", completedAt: now.toISOString(), producer },
  }).run();
  return taskId;
}

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

/** Persist a task's prompt-injection events (best-effort log, written by the workers). */
export async function recordSecurityEvents(
  db: any,
  agentId: string,
  taskId: string | null,
  events: { type: string; toolName: string; detail: string }[],
): Promise<void> {
  if (!events.length) return;
  const now = new Date();
  await db.insert(schema.securityEvents)
    .values(events.map((e) => ({ agentId, taskId, type: e.type, toolName: e.toolName, detail: e.detail, createdAt: now })))
    .run();
}

// What a scheduled task already delivered (the link ledger and the repeat check).
export * from "./cron-dedup.js";

/**
 * Load the channel's recent completed tasks for the workers' conversation
 * history, oldest last. Two guards keep stale context from derailing a run:
 *
 * - A cron-fired task gets NO chat history at all. Its prompt is self-contained
 *   and its prior-run context comes from buildCronDedupContext; feeding it the
 *   channel's chat can make a model re-execute an old imperative message
 *   ("remember that...") instead of the scheduled instruction.
 * - Interactive tasks see the last 20 exchanges of the last 30 days (the chat UI
 *   shows the same 30 days), so "the sites you suggested the other day" works.
 *   A message older than a day is handed back with its date in front, so a
 *   days-old request reads as an earlier conversation, not as a live one.
 * - The exchanges kept, newest first, stop at `maxChars` (see historyBudgetChars):
 *   a small local model does not get its context filled with old replies.
 */
export const HISTORY_DAYS = 30;
export const HISTORY_EXCHANGES = 20;

/** How much past conversation (characters) a task gets: less for a local model. */
export function historyBudgetChars(provider?: string): number {
  const env = Number(process.env.HYDRA_HISTORY_CHARS);
  if (env > 0) return env;
  return provider === "local" ? 30_000 : 120_000;
}

export async function loadRecentChannelHistory(
  db: any,
  channel: string,
  taskId: string,
  opts: { days?: number; limit?: number; maxChars?: number } = {},
): Promise<any[]> {
  const days = opts.days ?? HISTORY_DAYS;
  const limit = opts.limit ?? HISTORY_EXCHANGES;
  const maxChars = opts.maxChars ?? historyBudgetChars();
  const [current] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  if (current?.cronId) return [];

  const now = Date.now();
  const cutoff = new Date(now - days * 86_400_000);
  const rows: any[] = await db
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

  const kept: any[] = [];
  let used = 0;
  for (const row of rows) {
    const meta = row.resultMeta ?? {};
    const size = String(row.prompt ?? "").length + String(meta.text || meta.preview || meta.raw || "").length;
    if (kept.length && used + size > maxChars) break;
    used += size;
    const created = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
    const old = now - created > 86_400_000;
    kept.push(old ? { ...row, prompt: `[Earlier conversation, ${new Date(created).toISOString().slice(0, 10)}]\n${row.prompt}` } : row);
  }
  return kept;
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

export const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Store a held sensitive call (see @hydraops/addons provenance.ts); returns its id. */
export async function createPendingAction(
  db: any,
  a: { taskId: string; agentId: string; channel: string; toolName: string; args: unknown; origins: unknown },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.pendingActions).values({
    id, taskId: a.taskId, agentId: a.agentId, channel: a.channel, toolName: a.toolName,
    args: a.args ?? {}, origins: a.origins ?? [], status: "pending",
    createdAt: now, expiresAt: new Date(now.getTime() + PENDING_ACTION_TTL_MS),
  }).run();
  return id;
}

export async function loadPendingAction(db: any, id: string): Promise<any | null> {
  const rows = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Outcome of an approved call: executed | failed, with what the tool returned. */
export async function finishPendingAction(db: any, id: string, status: "executed" | "failed", result: string): Promise<void> {
  await db.update(schema.pendingActions).set({ status, result, decidedAt: new Date() }).where(eq(schema.pendingActions.id, id)).run();
}

/** Every held call of a task (any status), oldest first. */
export async function loadTaskActions(db: any, taskId: string): Promise<any[]> {
  return db.select().from(schema.pendingActions).where(eq(schema.pendingActions.taskId, taskId)).orderBy(schema.pendingActions.createdAt);
}

// Every continuation follows a decision a person took, so the chain is bounded by that person;
// the limit only stops a runaway, and when it does the outcome is still told (see below).
export const CONTINUATION_MAX_DEPTH = 20;
export const CONTINUATION_LIMIT = "continuation_limit";

/**
 * Once every call a task asked approval for has been decided (and at least one ran), the
 * agent gets a follow-up task in the same chat with the outcomes, so it can carry on
 * instead of stopping at "approve and I'll continue". The worker composes the real
 * message from the actions (see @hydraops/addons approvals.ts continuationPrompt); the
 * row's prompt is the short line the chat shows. Idempotent: one continuation per task,
 * chains stop after CONTINUATION_MAX_DEPTH (the chat then gets a completed notice with the
 * outcome of the decided calls, never silence), and a task still waiting on a decision, or
 * that did not complete, gets none. Returns the new task id, or null when nothing was
 * created.
 */
export async function createContinuationTask(db: any, opts: { taskId: string; producer: string; prompt?: string }): Promise<string | null> {
  const [original] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, opts.taskId)).limit(1);
  if (!original || original.status !== "completed") return null;
  const actions = await loadTaskActions(db, opts.taskId);
  if (!actions.length || actions.some((a: any) => a.status === "pending" || a.status === "approved")) return null;
  if (!actions.some((a: any) => a.status === "executed" || a.status === "failed")) return null;
  const existing = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.continuationOf, opts.taskId)).limit(1);
  if (existing.length) return null;
  // How far back does this chain go? A run of approvals must not continue forever.
  let depth = 0;
  for (let cursor = original; cursor?.continuationOf && depth < CONTINUATION_MAX_DEPTH; depth++) {
    const [prev] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, cursor.continuationOf)).limit(1);
    cursor = prev;
  }
  if (depth >= CONTINUATION_MAX_DEPTH) return continuationLimitNotice(db, original, actions, opts.producer);

  // The outside content that reached the original task reaches this one too.
  const origins: { tool: string; ref?: string }[] = [];
  const seen = new Set<string>();
  const push = (o: any) => { if (o && o.tool && !seen.has(o.tool + "|" + (o.ref ?? ""))) { seen.add(o.tool + "|" + (o.ref ?? "")); origins.push({ tool: String(o.tool), ...(o.ref ? { ref: String(o.ref) } : {}) }); } };
  for (const o of Array.isArray(original.inheritedTaint) ? original.inheritedTaint : []) push(o);
  for (const o of (original.resultMeta as any)?.security?.origins ?? []) push(o);
  for (const a of actions) for (const o of Array.isArray(a.origins) ? a.origins : []) push(o);

  const prompt = opts.prompt ?? `Continuing after your decision: ${actions.map((a: any) => `${a.toolName} ${a.status === "executed" ? "✓" : a.status === "failed" ? "✗" : "—"}`).join(", ")}`;
  const taskId = randomUUID();
  const eventId = randomUUID();
  const occurredAt = new Date();
  const envelope = {
    specVersion: "1.0", id: eventId, type: "task.created", version: 1, occurredAt: occurredAt.toISOString(), producer: opts.producer,
    subject: { entity: "task", id: taskId },
    data: { taskId, prompt, userId: "system-admin", channel: original.channel, priority: "normal", date: occurredAt.toISOString(), continuationOf: opts.taskId },
  };
  await db.transaction((tx: any) => {
    tx.insert(schema.tasks).values({
      id: taskId, prompt, channel: original.channel, status: "pending", isRead: original.isRead ?? true,
      ...(origins.length ? { inheritedTaint: origins } : {}),
      continuationOf: opts.taskId, createdAt: occurredAt, updatedAt: occurredAt,
    }).run();
    tx.insert(schema.events).values({
      id: eventId, type: envelope.type, version: envelope.version, occurredAt, producer: envelope.producer,
      subjectEntity: envelope.subject.entity, subjectId: envelope.subject.id, payload: envelope,
    }).run();
    tx.insert(schema.outbox).values({ eventId, status: "pending", nextAttemptAt: occurredAt }).run();
  });
  return taskId;
}

/** Pending actions past their deadline become 'expired'; returns how many. */
export async function expirePendingActions(db: any): Promise<number> {
  const result: any = await db.update(schema.pendingActions)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(schema.pendingActions.status, "pending"), lt(schema.pendingActions.expiresAt, new Date())))
    .run();
  return Number(result?.changes ?? result?.rowCount ?? 0);
}

/** Same retention for the prompt-injection log (see recordSecurityEvents). */
export async function purgeOldSecurityEvents(db: any, retentionDays = 60): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1, Math.floor(retentionDays)) * 86_400_000);
  const result: any = await db.delete(schema.securityEvents).where(lt(schema.securityEvents.createdAt, cutoff)).run();
  return Number(result?.changes ?? result?.rowCount ?? 0);
}

export * from "./cron-sources.js";

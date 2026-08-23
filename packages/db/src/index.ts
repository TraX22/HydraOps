import * as sqliteSchema from "./schema.js";
import { lt } from "drizzle-orm";
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

// Orchestrator — consumes task.created, assigns an agent, emits agent.task_assigned
// via the transactional outbox. Also schedules cron jobs (cron_jobs table).
// Reconstructed 2026-07-21 after source loss; behavior per original architecture:
//   channel === agentId → direct assignment; otherwise mention-match → round-robin.
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { loadEnv, envFile, agentsDir, logsDir } from "@hydraops/config";

loadDotenv({ path: envFile });

import {
  createDb,
  events as eventsTable,
  outbox as outboxTable,
  processedEvents,
  tasks,
  agentConfigs,
  cronJobs,
  workerStatus,
} from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, subjectForType } from "@hydraops/nats";
import { eq } from "drizzle-orm";
import { AckPolicy } from "nats";

const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "orchestrator" });
const consumerName = env.SERVICE_NAME;

// --- file logging → storage/logs/<service>.log (served by GET /workers/:id/logs) ---
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
const logStream = createWriteStream(path.join(logsDir, `${consumerName}.log`), { flags: "a" });
for (const level of ["log", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { logStream.write(`[${new Date().toISOString()}]${level === "error" ? " ERROR:" : ""} ${args.map(String).join(" ")}\n`); } catch { /* ignore */ }
    orig(...args);
  };
}

const { db, pool } = createDb(env.DATABASE_URL);
const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);
const js = await getJs(nc);

console.log(`[orchestrator] listening for task.created on ${env.NATS_URL}`);

// --- HEARTBEAT ---
async function sendHeartbeat() {
  try {
    await (db as any)
      .insert(workerStatus)
      .values({ workerId: "orchestrator", status: "online", lastHeartbeat: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: workerStatus.workerId,
        set: { status: "online", lastHeartbeat: new Date(), updatedAt: new Date() },
      })
      .run();
  } catch { /* silent */ }
}
sendHeartbeat();
setInterval(sendHeartbeat, 20_000);

// --- AGENT ROUTING ---

async function listAgentIds(): Promise<string[]> {
  try {
    const dirs = await readdir(agentsDir, { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return [];
  }
}

let roundRobinIdx = 0;

async function pickAgent(channel: string, prompt: string): Promise<{ agentId: string; workerType: string }> {
  const agentIds = await listAgentIds();
  const configs = await (db as any).select().from(agentConfigs);
  const workerTypeOf = (id: string) =>
    configs.find((c: any) => c.agentId === id)?.workerType ?? "coder";

  // 1) Private channel: the channel IS the agent id — absolute priority
  if (channel !== "main" && agentIds.includes(channel)) {
    return { agentId: channel, workerType: workerTypeOf(channel) };
  }

  // 2) Mention match: "@elena" or the bare name at the start of the prompt
  const lower = prompt.toLowerCase();
  for (const id of agentIds) {
    if (lower.includes(`@${id.toLowerCase()}`) || lower.startsWith(id.toLowerCase())) {
      return { agentId: id, workerType: workerTypeOf(id) };
    }
  }

  // 3) Round-robin over configured agents (fall back to any agent dir)
  const pool = configs.length > 0 ? configs.map((c: any) => c.agentId).filter((id: string) => agentIds.includes(id)) : agentIds;
  const candidates = pool.length > 0 ? pool : agentIds;
  if (candidates.length === 0) throw new Error("No agents available for assignment");
  const agentId = candidates[roundRobinIdx++ % candidates.length];
  return { agentId, workerType: workerTypeOf(agentId) };
}

// Insert an event + outbox row atomically (outbox pattern — outbox-worker publishes it)
function enqueueEvent(envelope: ReturnType<typeof buildEnvelope>) {
  (db as any).transaction((tx: any) => {
    tx.insert(eventsTable)
      .values({
        id: envelope.id,
        type: envelope.type,
        version: envelope.version,
        occurredAt: new Date(envelope.occurredAt),
        producer: envelope.producer,
        subjectEntity: envelope.subject.entity,
        subjectId: envelope.subject.id,
        payload: envelope,
      })
      .run();
    tx.insert(outboxTable).values({ eventId: envelope.id, status: "pending", nextAttemptAt: new Date() }).run();
  });
}

async function assignTask(taskId: string, channel: string, prompt: string) {
  const { agentId, workerType } = await pickAgent(channel, prompt);

  const envelope = buildEnvelope({
    id: randomUUID(),
    type: "agent.task_assigned",
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: consumerName,
    subject: { entity: "task", id: taskId },
    data: {
      taskId,
      agentId,
      workerType,
      channel,
      prompt,
      assignedAt: new Date().toISOString(),
    },
  });

  enqueueEvent(envelope);
  await (db as any)
    .update(tasks)
    .set({ status: "assigned", assignedAgent: agentId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  console.log(`[orchestrator] Task ${taskId} → agent "${agentId}" (${workerType}) on channel "${channel}"`);
}

// --- TASK.CREATED CONSUMER ---
const sub = await js.pullSubscribe(subjectForType("task.created"), {
  stream: "EVENTS",
  config: {
    durable_name: "orchestrator_task_created",
    ack_policy: AckPolicy.Explicit,
  },
});
sub.pull({ batch: 1, expires: 1000 });
setInterval(() => sub.pull({ batch: 1, expires: 1000 }), 1000);

(async () => {
  for await (const m of sub) {
    try {
      const raw = JSON.parse(new TextDecoder().decode(m.data));
      const envlp = parseEnvelope(raw);

      const inserted = await (db as any)
        .insert(processedEvents)
        .values({ consumerName, eventId: envlp.id })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });

      if (inserted.length === 0) {
        m.ack();
        continue;
      }

      const { taskId, prompt, channel } = envlp.data as any;
      await assignTask(taskId, channel ?? "main", prompt ?? "");
      m.ack();
    } catch (err) {
      console.error("[orchestrator] Error processing task.created:", err);
      m.ack(); // don't poison-pill the stream; task stays "pending" and can be retried via API
    }
  }
})();

// --- CRON SCHEDULER ---
// Minimal 5-field cron matcher: "min hour dom mon dow" with *, */n, a-b, a,b,c
function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (stepMatch[1] === "*") return value % step === 0;
      const [lo, hi] = stepMatch[1].split("-").map(Number);
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      return value >= lo && value <= hi;
    }
    return parseInt(part, 10) === value;
  });
}

function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    fieldMatches(min, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(mon, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

let activeCrons: any[] = [];

async function reloadCrons() {
  try {
    activeCrons = await (db as any).select().from(cronJobs).where(eq(cronJobs.status, "active"));
    console.log(`[orchestrator] Cron jobs loaded: ${activeCrons.length} active`);
  } catch (e) {
    console.error("[orchestrator] Failed to load cron jobs", e);
  }
}
await reloadCrons();

async function createTaskFromCron(cron: any) {
  const taskId = randomUUID();
  // No "smart routing" for crons: run on the assigned agent, or fall back to the
  // first agent in the list (never the diluted shared "main" channel). The channel
  // IS the agent id, so results still land in that agent's chat and pickAgent
  // routes straight to it.
  const channel = cron.assignedAgent || (await listAgentIds())[0] || "main";
  const occurredAt = new Date().toISOString();

  const envelope = buildEnvelope({
    id: randomUUID(),
    type: "task.created",
    version: 1,
    occurredAt,
    producer: consumerName,
    subject: { entity: "task", id: taskId },
    data: {
      taskId,
      prompt: cron.prompt,
      userId: "cron",
      channel,
      priority: "normal",
      date: occurredAt,
    },
  });

  (db as any).transaction((tx: any) => {
    tx.insert(tasks)
      .values({
        id: taskId,
        prompt: cron.prompt,
        channel,
        status: "pending",
        cronId: cron.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    tx.insert(eventsTable)
      .values({
        id: envelope.id,
        type: envelope.type,
        version: envelope.version,
        occurredAt: new Date(envelope.occurredAt),
        producer: envelope.producer,
        subjectEntity: envelope.subject.entity,
        subjectId: envelope.subject.id,
        payload: envelope,
      })
      .run();
    tx.insert(outboxTable).values({ eventId: envelope.id, status: "pending", nextAttemptAt: new Date() }).run();
  });

  await (db as any).update(cronJobs).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(cronJobs.id, cron.id));
  console.log(`[orchestrator] ⏰ Cron "${cron.name}" fired → task ${taskId} on channel "${channel}"`);
}

let lastCheckedMinute = -1;
setInterval(async () => {
  const now = new Date();
  const minuteKey = now.getHours() * 60 + now.getMinutes();
  if (minuteKey === lastCheckedMinute) return;
  lastCheckedMinute = minuteKey;

  for (const cron of activeCrons) {
    try {
      if (!cronMatches(cron.cronExpression, now)) continue;
      // Guard: skip if it already ran within this minute (e.g. after a restart)
      const last = cron.lastRunAt ? new Date(cron.lastRunAt) : null;
      if (last && now.getTime() - last.getTime() < 60_000) continue;
      await createTaskFromCron(cron);
      cron.lastRunAt = now;
    } catch (e) {
      console.error(`[orchestrator] Cron "${cron.name}" failed:`, e);
    }
  }
}, 15_000);

// --- SYSTEM.CRON_UPDATED CONSUMER (reload on changes from the API) ---
const cronSub = await js.pullSubscribe(subjectForType("system.cron_updated"), {
  stream: "EVENTS",
  config: {
    durable_name: "orchestrator_cron_updated",
    ack_policy: AckPolicy.Explicit,
  },
});
cronSub.pull({ batch: 1, expires: 1000 });
setInterval(() => cronSub.pull({ batch: 1, expires: 1000 }), 2000);

(async () => {
  for await (const m of cronSub) {
    try {
      await reloadCrons();
    } catch (e) {
      console.error("[orchestrator] cron reload failed", e);
    }
    m.ack();
  }
})();

process.on("SIGINT", async () => {
  console.log("[orchestrator] Shutting down...");
  if (pool && "end" in pool) await (pool as any).end();
  await nc.drain();
  process.exit(0);
});

// Proactive push notifications.
//
// The bot subscribes to two NATS events every worker publishes — `agent.result_generated`
// on success and `task.failed` on a hard error — and, for tasks that came from a
// CRON, messages the outcome to every allowlisted Telegram chat. Cron origin isn't
// on the event or the tasks row; it lives in the originating `task.created` payload
// (userId: "cron"), which we look up in the events table by taskId. Telegram- and
// app-originated tasks are therefore skipped naturally (the reactive flow already
// replies to Telegram ones). Successes and failures are gated by independent toggles
// (notifications.cron / notifications.cronFailures).

import { createDb, tasks, events, cronJobs, processedEvents } from "@hydraops/db";
import { parseEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, subjectForType } from "@hydraops/nats";
import { and, eq } from "drizzle-orm";
import { AckPolicy, type NatsConnection } from "nats";

const CONSUMER = "telegram-bot";

export interface NotifierConfig {
  enabled: boolean;
  allowlist: number[];
  notifications?: { cron?: boolean; cronFailures?: boolean };
}

export interface NotifierDeps {
  db: ReturnType<typeof createDb>["db"];
  natsUrl: string;
  getConfig: () => Promise<NotifierConfig>;
  getToken: () => Promise<string>;
  sendMessage: (token: string, chatId: number, text: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The result event is published just before the worker flips the row to
// "completed", so the full text may not be persisted yet. Retry briefly.
async function readResult(db: any, taskId: string): Promise<{ text: string; channel: string; prompt: string } | null> {
  for (let i = 0; i < 5; i++) {
    const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const row = rows[0];
    if (row) {
      const meta = (row.resultMeta || {}) as any;
      if (row.status === "completed" || row.status === "failed" || meta.text) {
        return { text: meta.text || meta.error || "", channel: row.channel || "", prompt: row.prompt || "" };
      }
    }
    await sleep(600);
  }
  return null;
}

// Lightweight read of a task's prompt + channel (used for failure notifications,
// which have no result text to wait on).
async function readTask(db: any, taskId: string): Promise<{ channel: string; prompt: string } | null> {
  try {
    const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const row = rows[0];
    return row ? { channel: row.channel || "", prompt: row.prompt || "" } : null;
  } catch {
    return null;
  }
}

// Cron origin lives in the originating task.created event payload.
async function isCronTask(db: any, taskId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.subjectId, taskId), eq(events.type, "task.created")))
      .limit(1);
    const data = (rows[0]?.payload as any)?.data;
    return data?.userId === "cron";
  } catch {
    return false;
  }
}

// Best-effort cron name: cron-fired tasks reuse the cron prompt verbatim on the
// cron's assigned agent (= the task channel).
async function cronName(db: any, prompt: string, channel: string): Promise<string> {
  try {
    const rows = await db
      .select({ name: cronJobs.name })
      .from(cronJobs)
      .where(and(eq(cronJobs.prompt, prompt), eq(cronJobs.assignedAgent, channel)))
      .limit(1);
    return rows[0]?.name || "";
  } catch {
    return "";
  }
}

// One event kind (success or failure): how to gate it and how to render it.
interface Flow {
  type: "agent.result_generated" | "task.failed";
  durable: string;
  gate: (cfg: NotifierConfig) => boolean;
  build: (db: any, data: any) => Promise<string>;
}

async function buildResult(db: any, data: any): Promise<string> {
  const result = await readResult(db, data.taskId);
  const body = (result?.text || data.preview || "(no output)").trim();
  const name = result ? await cronName(db, result.prompt, result.channel) : "";
  const agent = data.agentId || result?.channel || "agent";
  const seconds = Math.max(1, Math.round((data.durationMs || 0) / 1000));
  const header = name ? `🔔 Cron "${name}" · ${agent}` : `🔔 ${agent} · scheduled task`;
  const footer = `\n\n⏱ ${seconds}s · ${data.tokensUsed || 0} tok`;
  return `${header}\n\n${body}${footer}`;
}

async function buildFailure(db: any, data: any): Promise<string> {
  const task = await readTask(db, data.taskId);
  const agent = data.agentId || task?.channel || "agent";
  const name = task ? await cronName(db, task.prompt, task.channel) : "";
  const seconds = Math.max(1, Math.round((data.durationMs || 0) / 1000));
  const err = (data.error || "unknown error").trim();
  const header = name ? `❌ Cron "${name}" failed · ${agent}` : `❌ ${agent} · scheduled task failed`;
  const footer = `\n\n⏱ ${seconds}s`;
  return `${header}\n\n${err}${footer}`;
}

const FLOWS: Flow[] = [
  {
    type: "agent.result_generated",
    durable: "telegram_bot_result_generated",
    gate: (cfg) => cfg.notifications?.cron !== false,
    build: buildResult,
  },
  {
    type: "task.failed",
    durable: "telegram_bot_task_failed",
    gate: (cfg) => cfg.notifications?.cronFailures !== false,
    build: buildFailure,
  },
];

// Wire one durable pull-subscription that turns matching cron events into pushes.
async function runFlow(nc: NatsConnection, deps: NotifierDeps, flow: Flow): Promise<void> {
  const { db, getConfig, getToken, sendMessage } = deps;
  const js = await getJs(nc);

  const sub = await js.pullSubscribe(subjectForType(flow.type), {
    stream: "EVENTS",
    config: { durable_name: flow.durable, ack_policy: AckPolicy.Explicit },
  });
  sub.pull({ batch: 10, expires: 1000 });
  setInterval(() => sub.pull({ batch: 10, expires: 1000 }), 1000);

  console.log(`[telegram-bot] notifier subscribed to ${flow.type}`);

  for await (const m of sub) {
    try {
      const envlp = parseEnvelope(JSON.parse(new TextDecoder().decode(m.data)));

      // Idempotency: a redelivery must not double-notify.
      const inserted = await (db as any)
        .insert(processedEvents)
        .values({ consumerName: CONSUMER, eventId: envlp.id })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });
      if (inserted.length === 0) { m.ack(); continue; }

      const data = envlp.data as any;
      const taskId: string = data.taskId;

      // Only cron-originated tasks are notified.
      if (!(await isCronTask(db, taskId))) { m.ack(); continue; }

      // Config gate (checked AFTER dedupe so a disabled toggle still marks the
      // event processed and never re-fires when turned back on).
      const cfg = await getConfig();
      const token = await getToken();
      if (!cfg.enabled || !token || !flow.gate(cfg) || cfg.allowlist.length === 0) {
        m.ack();
        continue;
      }

      const message = await flow.build(db, data);
      for (const chatId of cfg.allowlist) {
        try {
          await sendMessage(token, chatId, message);
        } catch (e) {
          console.error(`[telegram-bot] notify send to ${chatId} failed`, e);
        }
      }
      console.log(`[telegram-bot] notified ${cfg.allowlist.length} chat(s) about ${flow.type} for task ${taskId}`);
      m.ack();
    } catch (e) {
      console.error(`[telegram-bot] notifier error (${flow.type})`, e);
      m.ack(); // never poison-pill the stream
    }
  }
}

export async function startNotifier(deps: NotifierDeps): Promise<void> {
  const nc = await connectNats(deps.natsUrl);
  await ensureEventsStream(nc);

  // Each flow runs its own async loop; they share the connection and the
  // app-level dedupe table but use distinct durable consumers.
  for (const flow of FLOWS) {
    runFlow(nc, deps, flow).catch((e) =>
      console.error(`[telegram-bot] notifier flow ${flow.type} crashed`, e),
    );
  }

  process.on("SIGINT", () => { nc.drain().catch(() => {}); });
}

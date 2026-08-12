import { config as loadDotenv } from "dotenv";
import { loadEnv, envFile, logsDir } from "@hydraops/config";
import { createDb, events, outbox, workerStatus } from "@hydraops/db";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType } from "@hydraops/nats";
import { eq, and, lte, isNull, or } from "drizzle-orm";

loadDotenv({ path: envFile });

const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "outbox-worker" });

// --- file logging → storage/logs/<service>.log (served by GET /workers/:id/logs) ---
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
const logStream = createWriteStream(path.join(logsDir, `${env.SERVICE_NAME}.log`), { flags: "a" });
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

console.log(`[outbox-worker] Running — polling outbox every 500ms on ${env.NATS_URL}`);

async function sendHeartbeat() {
  try {
    await (db as any)
      .insert(workerStatus)
      .values({ workerId: "outbox-worker", status: "online", lastHeartbeat: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: workerStatus.workerId,
        set: { status: "online", lastHeartbeat: new Date(), updatedAt: new Date() },
      })
      .run();
  } catch (e) {
    console.error("[outbox-worker] heartbeat failed", e);
  }
}
sendHeartbeat();
setInterval(sendHeartbeat, 20_000);

async function processPendingOutbox() {
  try {
    const now = new Date();
    const pending = await (db as any)
      .select({
        eventId: outbox.eventId,
        attempts: outbox.attempts,
        payload: events.payload,
        type: events.type,
      })
      .from(outbox)
      .innerJoin(events, eq(outbox.eventId, events.id))
      .where(
        and(
          eq(outbox.status, "pending"),
          or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now))
        )
      )
      .limit(20);

    for (const row of pending) {
      const { eventId, payload, type } = row;
      try {
        const subject = subjectForType(type);
        await publishJson(js, subject, payload);
        await (db as any)
          .update(outbox)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(outbox.eventId, eventId))
          .run();
        console.log(`[outbox-worker] ✅ Published event ${eventId} → ${subject}`);
      } catch (publishErr: any) {
        console.error(`[outbox-worker] ❌ Failed to publish ${eventId}:`, publishErr);
        const attempts = (row.attempts ?? 0) + 1;
        const backoffMs = Math.min(1000 * Math.pow(2, attempts), 60_000);
        const nextAttempt = new Date(Date.now() + backoffMs);
        await (db as any)
          .update(outbox)
          .set({
            attempts,
            nextAttemptAt: nextAttempt,
            lastError: String(publishErr?.message ?? publishErr),
            ...(attempts >= 5 ? { status: "dead" } : {}),
          })
          .where(eq(outbox.eventId, eventId))
          .run();
      }
    }
  } catch (err) {
    console.error("[outbox-worker] Error polling outbox:", err);
  }
}

processPendingOutbox();
setInterval(processPendingOutbox, 500);

process.on("SIGINT", async () => {
  console.log("[outbox-worker] Shutting down...");
  if (pool && "end" in pool) await (pool as any).end();
  await nc.drain();
  process.exit(0);
});

import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../../.env") });

import { createDb, events, outbox } from "./index.js";
import { eq, desc, and, lte } from "drizzle-orm";

const { db } = createDb(process.env.DATABASE_URL!);

// Count pending outbox
const pendingAll = await (db as any)
  .select()
  .from(outbox)
  .where(eq((outbox as any).status, "pending"));
  
console.log(`Pending outbox items: ${pendingAll.length}`);

// Show last 5 outbox items
const recentOutbox = await (db as any)
  .select()
  .from(outbox)
  .orderBy(desc((outbox as any).eventId))
  .limit(10);

console.log("\nMost recent outbox:");
for (const o of recentOutbox) {
  console.log(`  ${o.eventId?.slice(0,8)}... | status: ${o.status} | nextAttemptAt: ${o.nextAttemptAt} | lastError: ${o.lastError || 'none'}`);
}

// Check if event IDs from outbox exist in events table
const pendingOutbox = await (db as any)
  .select()
  .from(outbox)
  .where(eq((outbox as any).status, "pending"))
  .limit(5);

for (const p of pendingOutbox) {
  const evRows = await (db as any).select().from(events).where(eq((events as any).id, p.eventId)).limit(1);
  const ev = evRows[0];
  console.log(`\nPending event ${p.eventId?.slice(0,8)}...:`);
  if (ev) {
    console.log(`  type: ${ev.type}, payload: ${JSON.stringify((ev.payload as any).data).slice(0, 80)}`);
  } else {
    console.log(`  NOT FOUND IN EVENTS TABLE!`);
  }
}

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: (await import("@hydraops/config")).envFile });

import { loadEnv } from "@hydraops/config";
import { connectNats, ensureEventsStream, getJs, subjectForType } from "@hydraops/nats";

const env = loadEnv({ ...process.env, SERVICE_NAME: "nats-debug" });

const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);

const jsm = await nc.jetstreamManager();

// Get stream info
const streamInfo = await jsm.streams.info("EVENTS");
console.log("=== STREAM INFO ===");
console.log("Messages:", streamInfo.state?.messages);
console.log("Bytes:", streamInfo.state?.bytes);
console.log("Consumer count:", streamInfo.state?.consumer_count);
console.log("Subjects:", streamInfo.config?.subjects);

// List consumers
const consumers = jsm.consumers.list("EVENTS");
for await (const c of consumers) {
  console.log("\n=== CONSUMER:", c.name, "===");
  console.log("  Delivered:", c.delivered?.consumer_seq, "of", c.delivered?.stream_seq);
  console.log("  Ack Pending:", c.num_ack_pending);
  console.log("  Pending:", c.num_pending);
  console.log("  Filter:", c.filter_subject);
}

await nc.drain();

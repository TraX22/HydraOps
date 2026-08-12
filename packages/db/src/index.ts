import * as sqliteSchema from "./schema.js";
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

export * from "./client.js";

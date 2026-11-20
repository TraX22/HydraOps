import { z } from "zod";

export * from "./paths.js";
export * from "./private-file.js";
export * from "./keystore.js";
export * from "./local-llm.js";

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1),
  RESULTS_DIR: z.string().default("./storage"),
  SERVICE_NAME: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * The four settings a service needs, read by name. The whole environment is never handed
 * on: it also holds whatever else the machine has in it (tokens of other programs), and
 * nothing of that should travel with the values the services log.
 */
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse({
    DATABASE_URL: input.DATABASE_URL,
    NATS_URL: input.NATS_URL,
    RESULTS_DIR: input.RESULTS_DIR,
    SERVICE_NAME: input.SERVICE_NAME,
  });
}

/**
 * A URL as it can be written to a log: without the user and password it may carry
 * (nats://user:password@host). Text that is not a URL comes back as "(unreadable address)",
 * never as it was.
 */
export function urlForLog(url: string): string {
  try {
    const u = new URL(url);
    // "user:pass@host" with no scheme parses as a URL with no host: not one to echo.
    if (!u.host) return "(unreadable address)";
    if (u.username || u.password) { u.username = ""; u.password = ""; }
    return u.toString().replace(/\/$/, "");
  } catch { return "(unreadable address)"; }
}

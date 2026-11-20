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
 * An address as it can be written to a log: only its scheme, host and port. The user and
 * password it may carry (nats://user:password@host), and its path, query and fragment
 * (a token can travel in any of them), are left out. A list of servers separated by commas
 * is handled one by one. Text that is not an address comes back as "(unreadable address)",
 * never as it was.
 */
export function urlForLog(url: string): string {
  const one = (text: string): string => {
    try {
      const u = new URL(text.trim());
      // "user:pass@host" with no scheme parses as a URL with no host: not one to echo.
      return u.host ? `${u.protocol}//${u.host}` : "(unreadable address)";
    } catch { return "(unreadable address)"; }
  };
  return String(url ?? "").split(",").filter((part) => part.trim()).map(one).join(", ") || "(unreadable address)";
}

import { z } from "zod";

export * from "./paths.js";
export * from "./local-llm.js";

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1),
  RESULTS_DIR: z.string().default("./storage"),
  SERVICE_NAME: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}

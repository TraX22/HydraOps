import { z } from "zod";

// Example custom addon: current date & time, optionally in a given timezone.
export const getCurrentTimeTool = {
  name: "get_current_time",
  description:
    "Returns the current date and time. Use it whenever the user asks about today's date, the current time, or 'now'.",
  schema: z.object({
    timezone: z
      .string()
      .optional()
      .describe("Optional IANA timezone, e.g. 'Europe/Madrid' or 'America/Argentina/Buenos_Aires'"),
  }),
  execute: async ({ timezone }: { timezone?: string }) => {
    try {
      return new Date().toLocaleString("es-ES", {
        dateStyle: "full",
        timeStyle: "long",
        ...(timezone ? { timeZone: timezone } : {}),
      });
    } catch {
      return `Invalid timezone '${timezone}'. Current server time: ${new Date().toString()}`;
    }
  },
};

import { z } from "zod";
import { HydraTool } from "../../../types.js";

// send_to_telegram — let an agent deliver a message to the user's Telegram
// (their paired chats) ON DEMAND, e.g. when the user says "send this to
// Telegram". The agent never sees the bot token: it calls the local HydraOps
// API (loopback), which reads the token from the key store and the recipient
// allowlist from telegram_config, then sends via the Telegram Bot API. This is
// separate from the automatic cron push done by the telegram-bot notifier.

const apiUrl = () =>
  (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

async function sendToTelegram(text: string, title?: string): Promise<string> {
  const body: Record<string, string> = { text };
  if (title && title.trim()) body.title = title.trim();
  try {
    const r = await fetch(`${apiUrl()}/api/telegram/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await r.json().catch(() => ({}));
    if (r.ok && data?.ok) {
      const n = Number(data.sent) || 0;
      return `Message delivered to Telegram (${n} chat${n === 1 ? "" : "s"}).`;
    }
    switch (data?.reason) {
      case "disabled":
        return "Telegram isn't enabled. Ask the user to turn on the Telegram integration in Herramientas → Telegram and pair a chat first.";
      case "no_token":
        return "No Telegram bot token is configured. Ask the user to add it in Herramientas → Telegram.";
      case "no_chats":
        return "No Telegram chat is paired yet. Ask the user to open the bot and send /start with the pairing code, then try again.";
      case "send_failed":
        return "Telegram rejected the message (the bot may be blocked or the chat id is stale).";
      default:
        return `Could not send to Telegram${data?.error ? `: ${data.error}` : "."}`;
    }
  } catch (e: any) {
    return `Telegram send failed: ${e?.message || e}`;
  }
}

export const sendToTelegramTool: HydraTool = {
  name: "send_to_telegram",
  description:
    "Send a message to the user's Telegram (their paired chats via the HydraOps bot). Use this when the user asks to send, forward, or push something to Telegram — e.g. \"send this to Telegram\" or \"avísame por Telegram\". Pass the full text to deliver; optionally a short title shown above it.",
  schema: z.object({
    text: z.string().describe("The message body to deliver to Telegram."),
    title: z.string().optional().describe("Optional short title/heading shown above the message."),
  }),
  execute: async ({ text, title }) => await sendToTelegram(text, title),
};

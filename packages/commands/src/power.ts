import type { Command, CommandContext, CommandResult, PowerAction, PowerCard } from "./types.js";
import { fold } from "./util.js";

// /exit and /restart: stop or restart HydraOps as a whole, from the app, Telegram or a CLI.
//
// Neither does anything on its own: the first call describes what would happen (tasks in
// progress that get interrupted, scheduled tasks that stop, how to turn it on again) and
// opens a confirmation that lasts 60 seconds; only "/exit confirm" (or the card's button
// in the app) acts, and only for whoever asked, in the same conversation. The API then
// cancels the running tasks and hands the request to the supervisor (the desktop app or
// `pnpm serve`), which is the only process that can stop or restart the stack. Without a
// supervisor there is nothing to ask: the command says so.
//
// These are commands for people, never tools: no agent can call them.

export const POWER_CONFIRM_MS = 60_000;
const CONFIRM_WORDS = new Set(["confirm", "confirmar", "confirmo", "yes", "si", "sí", "ok"]);
const CANCEL_WORDS = new Set(["cancel", "cancelar", "no"]);

interface Pending { action: PowerAction; expiresAt: number }
const pending = new Map<string, Pending>();
const keyOf = (ctx: CommandContext) => `${ctx.transport}:${ctx.conversationId}:${ctx.senderId}`;

/** Test hook: forget every open confirmation. */
export function resetPowerConfirmations(): void { pending.clear(); }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describe(action: PowerAction, mode: "desktop" | "server", running: number, scheduled: number): string {
  const lines: string[] = [];
  if (action === "shutdown") {
    lines.push(mode === "desktop"
      ? "You are about to shut down HydraOps (desktop). Agents, scheduled tasks and Telegram stop until you open it again."
      : "You are about to shut down HydraOps (server mode). Agents, scheduled tasks and the Telegram bot stop.");
  } else {
    lines.push("You are about to restart HydraOps: every service stops and starts again. It takes about 20 seconds; the connection drops and comes back by itself.");
  }
  lines.push(running
    ? `• ${plural(running, "task", "tasks")} in progress will be interrupted (up to 5 seconds to save their state).`
    : "• No task is in progress.");
  if (action === "shutdown") {
    lines.push(scheduled ? `• ${plural(scheduled, "scheduled task", "scheduled tasks")} will not run while it is closed.` : "• No scheduled task is active.");
    lines.push(mode === "desktop"
      ? "• To come back: open HydraOps from its shortcut."
      : "• To turn it on again, someone has to log into the machine and start it: it cannot be done from Telegram. To restart instead of stopping, use /restart.");
  } else {
    lines.push("• Scheduled tasks keep their schedule.");
  }
  const cmd = action === "shutdown" ? "/exit" : "/restart";
  lines.push(`Confirm with ${cmd} confirm within 60 seconds.`);
  return lines.join("\n");
}

function card(action: PowerAction, state: PowerCard["state"], extra: Partial<PowerCard> = {}): PowerCard {
  return { kind: "power", action, state, mode: "none", running: 0, scheduled: 0, expiresAt: new Date(Date.now() + POWER_CONFIRM_MS).toISOString(), ...extra };
}

function makeHandler(action: PowerAction) {
  const cmd = action === "shutdown" ? "/exit" : "/restart";
  return async (ctx: CommandContext, args: string): Promise<CommandResult> => {
    const word = fold(args);
    const key = keyOf(ctx);
    const open = pending.get(key);

    if (CANCEL_WORDS.has(word)) {
      if (open?.action === action) pending.delete(key);
      return { text: action === "shutdown" ? "Nothing was shut down." : "Nothing was restarted.", kind: "info", card: card(action, "cancelled") };
    }

    if (CONFIRM_WORDS.has(word)) {
      if (!open || open.action !== action) {
        return { text: `Nothing to confirm: write ${cmd} first.`, kind: "error" };
      }
      pending.delete(key);
      if (Date.now() > open.expiresAt) {
        return { text: `The request expired. Write ${cmd} again if you still want it.`, kind: "info", card: card(action, "expired") };
      }
      const done = await ctx.api.power(action, `${ctx.transport}:${ctx.senderId}`);
      const interrupted = done.cancelled ? ` ${plural(done.cancelled, "task was", "tasks were")} interrupted.` : "";
      const text = action === "shutdown"
        ? `Shutting down HydraOps…${interrupted} Until next time.`
        : `Restarting HydraOps…${interrupted} Back in about 20 seconds.`;
      return { text, kind: "ok", card: card(action, "confirmed", { mode: done.mode, running: done.cancelled }) };
    }

    if (word) return { text: `Unknown option "${args.trim()}". Write ${cmd} to see what would happen, then ${cmd} confirm.`, kind: "error" };

    const preview = await ctx.api.powerPreview();
    if (preview.mode === "none") {
      return { text: "HydraOps is not running under its supervisor (the desktop app or `pnpm serve`), so there is nothing here that can stop it: use Ctrl+C in the terminal that started it.", kind: "error" };
    }
    pending.set(key, { action, expiresAt: Date.now() + POWER_CONFIRM_MS });
    return {
      text: describe(action, preview.mode, preview.running, preview.scheduled),
      kind: "info",
      card: card(action, "pending", { mode: preview.mode, running: preview.running, scheduled: preview.scheduled }),
    };
  };
}

export const POWER_COMMANDS: Command[] = [
  {
    name: "exit",
    aliases: ["salir", "quit"],
    usage: "/exit [confirm]",
    description: "Shut down HydraOps entirely (asks for confirmation first)",
    handler: makeHandler("shutdown"),
  },
  {
    name: "restart",
    aliases: ["reiniciar"],
    usage: "/restart [confirm]",
    description: "Stop and start every HydraOps service again (asks for confirmation first)",
    handler: makeHandler("restart"),
  },
];

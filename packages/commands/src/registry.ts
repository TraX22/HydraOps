import type { Command, CommandContext, CommandResult, CommandSpec } from "./types.js";
import { PHASE2_COMMANDS } from "./phase2.js";

import { findAgent, fold } from "./util.js";
export { findAgent, fold };

const STATUS_ICON: Record<string, string> = { online: "🟢", working: "🟠", idle: "⚪", offline: "🔴" };

const ok = (text: string, action?: CommandResult["action"]): CommandResult => ({ text, kind: "ok", action });
const info = (text: string, action?: CommandResult["action"]): CommandResult => ({ text, kind: "info", action });
const err = (text: string): CommandResult => ({ text, kind: "error" });

// Commands that act on "the agent I'm talking to" need one.
function requireAgent(ctx: CommandContext): string | CommandResult {
  if (ctx.activeAgent) return ctx.activeAgent;
  return err("This command works inside an agent's chat. Open one (or /use <agent>) and try again.");
}

const splitFirst = (args: string): [string, string] => {
  const t = args.trim();
  const i = t.search(/\s/);
  return i === -1 ? [t, ""] : [t.slice(0, i), t.slice(i + 1).trim()];
};

export const COMMANDS: Command[] = [
  {
    name: "help",
    aliases: ["ayuda", "commands", "start"],
    usage: "/help [command]",
    description: "List the available commands, or explain one",
    handler: async (_ctx, args) => {
      const which = fold(args);
      if (which) {
        const cmd = COMMANDS.find((c) => c.name === which || c.aliases?.includes(which));
        if (!cmd) return err(`Unknown command "/${which}". Try /help.`);
        const aliases = cmd.aliases?.length ? `\nAliases: ${cmd.aliases.map((a) => "/" + a).join(", ")}` : "";
        return info(`${cmd.usage ?? "/" + cmd.name} — ${cmd.description}${aliases}`);
      }
      const lines = COMMANDS.map((c) => `${c.usage ?? "/" + c.name} — ${c.description}`);
      return info(
        "Commands:\n" +
          lines.join("\n") +
          "\n/<agent> <message> — send a one-off message to that agent (the reply lands in its chat)",
      );
    },
  },
  {
    name: "agents",
    aliases: ["agentes", "list"],
    description: "List the agents with their status, worker and model",
    handler: async (ctx) => {
      const agents = await ctx.api.listAgents();
      if (!agents.length) return err("No agents are configured yet.");
      const lines = agents.map((a) => {
        const icon = STATUS_ICON[a.status ?? ""] ?? "⚪";
        const bits = [a.workerType, a.model].filter(Boolean).join(" · ");
        const active = ctx.activeAgent && fold(ctx.activeAgent) === fold(a.id) ? "  ⬅ active" : "";
        return `${icon} ${a.name} (/${a.id})${bits ? " — " + bits : ""}${active}`;
      });
      return info(lines.join("\n") + "\n\n/use <agent> to open its chat · /<agent> <message> for a one-off.");
    },
  },
  {
    name: "use",
    aliases: ["usar", "switch", "talk"],
    usage: "/use <agent>",
    description: "Open that agent's chat and make it the active one",
    handler: async (ctx, args) => {
      const [name] = splitFirst(args);
      if (!name) return err("Usage: /use <agent>. See /agents for the list.");
      const agent = findAgent(await ctx.api.listAgents(), name);
      if (!agent) return err(`No agent called "${name}". See /agents for the list.`);
      return ok(`Now talking to ${agent.name}.`, { type: "open_tab", agentId: agent.id });
    },
  },
  {
    name: "main",
    aliases: ["principal"],
    description: "Back to the main chat",
    handler: async () => ok("Back to the main chat.", { type: "main" }),
  },
  {
    name: "close",
    aliases: ["cerrar"],
    description: "Close the current chat tab",
    uiOnly: true,
    handler: async (ctx) => {
      if (!ctx.activeAgent) return err("The main chat cannot be closed.");
      return ok("Tab closed.", { type: "close_tab" });
    },
  },
  {
    name: "delegate",
    aliases: ["delegar"],
    usage: "/delegate <agent> <task>",
    description: "Create a task for another agent, from wherever you are",
    handler: async (ctx, args) => {
      const [name, task] = splitFirst(args);
      if (!name || !task) return err("Usage: /delegate <agent> <task>. Example: /delegate luna dibuja una nave espacial.");
      const agent = findAgent(await ctx.api.listAgents(), name);
      if (!agent) return err(`No agent called "${name}". See /agents for the list.`);
      const { taskId } = await ctx.api.createTask(agent.id, task, { isRead: false });
      return ok(`Task created for ${agent.name} (${taskId.slice(0, 8)}). The reply will appear in ${agent.name}'s chat.`, {
        type: "await_task",
        taskId,
        agentId: agent.id,
      });
    },
  },
  {
    name: "tasks",
    aliases: ["tareas"],
    description: "Latest tasks of this chat with their status",
    handler: async (ctx) => {
      const tasks = await ctx.api.listTasks(ctx.conversationId, 10);
      if (!tasks.length) return info("No tasks in this chat yet.");
      const ICON: Record<string, string> = { pending: "⏳", assigned: "🟠", completed: "✅", failed: "❌" };
      const lines = tasks.map((t) => {
        const when = t.createdAt.slice(11, 16);
        const who = t.agent ? ` · ${t.agent}` : "";
        return `${ICON[t.status] ?? "•"} ${when}${who} — ${t.prompt.replace(/\s+/g, " ").slice(0, 70)}`;
      });
      return info(lines.join("\n"));
    },
  },
  {
    name: "status",
    aliases: ["estado"],
    description: "System health: version, services and configured providers",
    handler: async (ctx) => {
      const s = await ctx.api.systemStatus();
      const update = s.latest && s.latest !== s.version ? ` (update available: ${s.latest})` : "";
      const services = s.workers.map((w) => `${w.status === "online" ? "✅" : "❌"} ${w.id}`).join("  ");
      const providers = s.providers.length ? s.providers.join(", ") : "none";
      return info(`HydraOps ${s.version}${update}\n${services}\nProviders with a key: ${providers}`);
    },
  },
  {
    name: "keys",
    aliases: ["claves"],
    description: "Which providers have an API key configured (never the values)",
    handler: async (ctx) => {
      const s = await ctx.api.systemStatus();
      return info(s.providers.length ? `Providers with a key: ${s.providers.join(", ")}` : "No provider keys configured yet.");
    },
  },
  {
    name: "remember",
    aliases: ["recordar"],
    usage: "/remember <note>",
    description: "Save a note to the active agent's permanent memory (no LLM involved)",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      if (!args.trim()) return err("Usage: /remember <note>.");
      return ok(await ctx.api.remember(agent, args));
    },
  },
  {
    name: "recall",
    aliases: ["buscar"],
    usage: "/recall <keywords>",
    description: "Search the active agent's past conversations",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const q = args.trim();
      if (!q) return err("Usage: /recall <keywords>.");
      const hits = await ctx.api.recall(agent, q);
      if (!hits.length) return info(`Nothing matched "${q}" in ${agent}'s past conversations.`);
      return info(hits.map((h) => `— ${h.date} — ${h.prompt.slice(0, 80)}\n   ${h.excerpt.slice(0, 160)}`).join("\n"));
    },
  },
  {
    name: "memory",
    aliases: ["memoria"],
    description: "Show the active agent's memory file",
    handler: async (ctx) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const text = (await ctx.api.readMemory(agent)).trim();
      return info(text || `${agent}'s memory is empty.`);
    },
  },
  {
    name: "telegram",
    usage: "/telegram <text>",
    description: "Send a text to your Telegram",
    handler: async (ctx, args) => {
      const text = args.trim();
      if (!text) return err("Usage: /telegram <text>.");
      const r = await ctx.api.sendTelegram(text);
      if (r.ok) return ok(`Sent to Telegram (${r.sent ?? 0} chat${r.sent === 1 ? "" : "s"}).`);
      const why: Record<string, string> = {
        disabled: "Telegram is disabled. Turn it on in Tools → Telegram.",
        no_token: "No Telegram bot token configured. Add it in Tools → Telegram.",
        no_chats: "No Telegram chat paired yet. Open the bot and send /start <pairing code>.",
        send_failed: "Telegram rejected the message.",
      };
      return err(why[r.reason ?? ""] ?? `Could not send to Telegram${r.error ? `: ${r.error}` : "."}`);
    },
  },
  {
    name: "oneshot",
    description: "Open the One Shot canvas",
    uiOnly: true,
    handler: async () => ok("Opening One Shot.", { type: "open_oneshot" }),
  },
  {
    name: "threed",
    aliases: ["3d", "objeto3d"],
    description: "Open the 3D plugin (the model writes Three.js, you see it)",
    uiOnly: true,
    handler: async () => ok("Opening 3D.", { type: "open_threed" }),
  },
  {
    name: "whoami",
    aliases: ["quien"],
    description: "Show who you are and the active agent",
    handler: async (ctx) => info(`You: ${ctx.senderId} (${ctx.transport})\nActive agent: ${ctx.activeAgent ?? "(none)"}`),
  },
];

// Phase 2 (configuration, scheduled tasks, UI switches) joins the same catalog.
COMMANDS.push(...PHASE2_COMMANDS);

/** The catalog a transport shows: everything but the handlers. */
export function catalog(): CommandSpec[] {
  return COMMANDS.map(({ name, aliases, usage, description, uiOnly }) => ({ name, aliases, usage, description, uiOnly }));
}

/**
 * Parse and run one "/…" line.
 *
 *   1. "/name …" where name is a command (or alias) → that command.
 *   2. "/name …" where name is an agent id or name → one-off task for that agent.
 *   3. anything else → unknown command.
 *
 * Plain text (no leading slash) is not a command: the transport sends it to
 * the active agent itself.
 */
export async function dispatch(rawText: string, ctx: CommandContext): Promise<CommandResult> {
  const text = rawText.trim();
  if (!text.startsWith("/")) return err("Not a command: commands start with /. Try /help.");

  const spaceIdx = text.search(/\s/);
  let name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  // Telegram appends "@botname" to commands in groups.
  const at = name.indexOf("@");
  if (at !== -1) name = name.slice(0, at);
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  const cmd = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (cmd) {
    if (cmd.uiOnly && ctx.transport !== "app") return info(`/${cmd.name} only works in the HydraOps app.`);
    return cmd.handler(ctx, args);
  }

  const agent = findAgent(await ctx.api.listAgents(), name);
  if (agent) {
    if (!args) return err(`Add a message: /${agent.id} <your message>`);
    const { taskId } = await ctx.api.createTask(agent.id, args, { isRead: false });
    return ok(`Sent to ${agent.name}. The reply will appear in ${agent.name}'s chat.`, { type: "await_task", taskId, agentId: agent.id });
  }

  return err(`Unknown command "/${name}". Try /help or /agents.`);
}

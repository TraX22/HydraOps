// Command registry + dispatcher for the transport-agnostic command layer.
// See ./types.ts for the migration note toward a future @hydraops/commands package.

import type { Command, CommandContext, CommandResult } from "./types.js";

function agentLine(a: { emoji?: string; name: string; id: string }): string {
  return `${a.emoji ? a.emoji + " " : ""}${a.name} — /${a.id}`;
}

export const BASE_COMMANDS: Command[] = [
  {
    name: "agents",
    aliases: ["list"],
    description: "List the available agents",
    handler: async (ctx) => {
      const agents = await ctx.api.listAgents();
      if (!agents.length) return { text: "No agents are configured yet." };
      const active = ctx.session.get() ?? ctx.defaultAgent;
      const lines = agents.map((a) => {
        const marker = active && a.id === active ? "  ⬅ active" : "";
        return agentLine(a) + marker;
      });
      return {
        text:
          "Agents:\n" +
          lines.join("\n") +
          "\n\nTalk to one with /<id> <message>, or set a default with /use <id>.",
      };
    },
  },
  {
    name: "use",
    aliases: ["switch", "talk"],
    description: "Set the agent this chat talks to (optionally with a first message)",
    usage: "/use <agentId> [message]",
    handler: async (ctx, args) => {
      const trimmed = args.trim();
      const id = trimmed.split(/\s+/)[0]?.toLowerCase();
      if (!id) return { text: "Usage: /use <agentId> [message]. See /agents for the list." };
      if (!(await ctx.api.hasAgent(id))) {
        return { text: `No agent called "${id}". See /agents for the list.` };
      }
      await ctx.session.set(id);
      // "/use <id> <message>" switches AND sends that first message right away.
      const rest = trimmed.slice(id.length).trim();
      if (rest) return { text: await ctx.api.sendToAgent(id, rest) };
      return { text: `Now talking to ${id}. Just type a message, or use /agents to switch.` };
    },
  },
  {
    name: "whoami",
    description: "Show your id and the active agent",
    handler: async (ctx) => {
      const active = ctx.session.get() ?? ctx.defaultAgent;
      return {
        text:
          `You: ${ctx.senderId}\n` +
          `Active agent: ${active ?? "(none — use /use <id>)"}`,
      };
    },
  },
  {
    name: "help",
    aliases: ["start", "commands"],
    description: "Show the available commands",
    handler: async (ctx) => {
      const lines = BASE_COMMANDS
        // "start" is only an alias for help; hide the transport-owned pairing use.
        .filter((c) => c.name !== "help")
        .map((c) => `/${c.name}${c.usage ? " — " + c.usage : ""} — ${c.description}`);
      return {
        text:
          "HydraOps bot — commands:\n" +
          "/help — this message\n" +
          lines.join("\n") +
          "\n/<agentId> <message> — send a one-off message to that agent\n" +
          "Plain text goes to your active agent.",
      };
    },
  },
];

/**
 * Parse and run a line of input.
 *
 * Resolution order:
 *   1. "/name …" where name is a registered command (or alias) → that command.
 *   2. "/name …" where name is an agent id → one-off message to that agent.
 *   3. plain text → the conversation's active agent (or the default).
 */
export async function dispatch(
  rawText: string,
  ctx: CommandContext,
  commands: Command[] = BASE_COMMANDS,
): Promise<CommandResult> {
  const text = rawText.trim();
  if (!text) return { text: "" };

  if (text.startsWith("/")) {
    const spaceIdx = text.search(/\s/);
    // Strip a "@botname" suffix Telegram appends in groups: "/agents@MyBot".
    let name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    const at = name.indexOf("@");
    if (at !== -1) name = name.slice(0, at);
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name));
    if (cmd) return cmd.handler(ctx, args);

    // Not a command — maybe it's an agent id (one-off message).
    if (await ctx.api.hasAgent(name)) {
      if (!args) return { text: `Add a message: /${name} <your message>` };
      const reply = await ctx.api.sendToAgent(name, args);
      return { text: reply };
    }

    return { text: `Unknown command "/${name}". Try /help or /agents.` };
  }

  // Plain text → active agent (or default).
  const target = ctx.session.get() ?? ctx.defaultAgent;
  if (!target) {
    return { text: "Pick an agent first: /use <id> (see /agents)." };
  }
  const reply = await ctx.api.sendToAgent(target, text);
  return { text: reply };
}

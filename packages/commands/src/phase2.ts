import type { Command, CommandContext, CommandResult, ModelInfo } from "./types.js";
import { fold } from "./util.js";
import { describeSchedule, parseSchedule } from "./schedule.js";

// Phase 2: quick configuration of the active agent, scheduled tasks, and a
// few UI switches. Same shape as the core commands (see registry.ts).

const ok = (text: string, action?: CommandResult["action"]): CommandResult => ({ text, kind: "ok", action });
const info = (text: string, action?: CommandResult["action"]): CommandResult => ({ text, kind: "info", action });
const err = (text: string): CommandResult => ({ text, kind: "error" });

function requireAgent(ctx: CommandContext): string | CommandResult {
  if (ctx.activeAgent) return ctx.activeAgent;
  return err("This command works inside an agent's chat. Open one (or /use <agent>) and try again.");
}

const splitFirst = (args: string): [string, string] => {
  const t = args.trim();
  const i = t.search(/\s/);
  return i === -1 ? [t, ""] : [t.slice(0, i), t.slice(i + 1).trim()];
};

// Exact id first, then an id that starts with the text, then id or name that
// contains it. Several loose matches → the caller shows them.
function matchModels(models: ModelInfo[], q: string): ModelInfo[] {
  const f = fold(q);
  const exact = models.find((m) => fold(m.id) === f);
  if (exact) return [exact];
  const starts = models.filter((m) => fold(m.id).startsWith(f));
  if (starts.length === 1) return starts;
  const loose = models.filter((m) => fold(m.id).includes(f) || fold(m.name).includes(f));
  return loose.length ? loose : starts;
}

const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const VIDEO_ASPECTS: Record<string, string[]> = {
  google: ["16:9", "9:16"],
  xai: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
  leonardo: ["16:9", "9:16", "3:4"],
};

async function aspectsFor(ctx: CommandContext, agentId: string): Promise<string[] | null> {
  const cfg = await ctx.api.getAgentConfig(agentId);
  if (cfg.workerType === "graphic") return IMAGE_ASPECTS;
  if (cfg.workerType !== "video") return null;
  const engine = cfg.graphicEngine && cfg.graphicEngine !== "auto" ? cfg.graphicEngine : "leonardo-ai";
  const provider = (await ctx.api.listModels()).find((m) => m.id === engine)?.provider ?? "leonardo";
  if (/grok-imagine-video/i.test(engine)) return VIDEO_ASPECTS["xai"];
  return VIDEO_ASPECTS[provider] ?? VIDEO_ASPECTS["leonardo"];
}

async function findCron(ctx: CommandContext, name: string) {
  const crons = await ctx.api.listCrons();
  const f = fold(name);
  const exact = crons.find((c) => fold(c.name) === f);
  if (exact) return { cron: exact, candidates: [] };
  const loose = crons.filter((c) => fold(c.name).includes(f));
  return loose.length === 1 ? { cron: loose[0], candidates: [] } : { cron: null, candidates: loose.length ? loose : crons };
}

export const PHASE2_COMMANDS: Command[] = [
  {
    name: "model",
    aliases: ["modelo"],
    usage: "/model [name]",
    description: "Show or change the active agent's LLM",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const q = args.trim();
      if (!q) {
        const cfg = await ctx.api.getAgentConfig(agent);
        return info(`${agent} uses ${cfg.model || "the default model"} (${cfg.workerType ?? "coder"} worker).`);
      }
      const models = (await ctx.api.listModels()).filter((m) => !m.isImage && !m.isVideo && m.type !== "audio" && m.type !== "embedding");
      const hits = matchModels(models, q);
      if (!hits.length) return err(`No model matches "${q}".`);
      if (hits.length > 1) return err(`"${q}" matches ${hits.length} models — be more specific:\n${hits.slice(0, 8).map((m) => `• ${m.id}`).join("\n")}`);
      await ctx.api.saveAgentConfig(agent, { model: hits[0].id });
      return ok(`${agent} now uses ${hits[0].id}.`);
    },
  },
  {
    name: "engine",
    aliases: ["motor"],
    usage: "/engine [name | auto]",
    description: "Show or change the active agent's image/video engine",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const cfg = await ctx.api.getAgentConfig(agent);
      if (cfg.workerType !== "graphic" && cfg.workerType !== "video") return err(`${agent} is a ${cfg.workerType ?? "coder"} worker: it has no image/video engine.`);
      const q = args.trim();
      if (!q) return info(`${agent}'s engine: ${cfg.graphicEngine || "auto"}.`);
      if (fold(q) === "auto") {
        await ctx.api.saveAgentConfig(agent, { graphicEngine: "auto", resolution: "auto" });
        return ok(`${agent}'s engine is back to automatic.`);
      }
      const wantVideo = cfg.workerType === "video";
      const engines = (await ctx.api.listModels()).filter((m) => (wantVideo ? m.isVideo : m.isImage));
      const hits = matchModels(engines, q);
      if (!hits.length) return err(`No ${wantVideo ? "video" : "image"} engine matches "${q}".`);
      if (hits.length > 1) return err(`"${q}" matches ${hits.length} engines — be more specific:\n${hits.slice(0, 8).map((m) => `• ${m.name} (${m.id})`).join("\n")}`);
      const patch: { graphicEngine: string; resolution?: string } = { graphicEngine: hits[0].id };
      // An aspect the new engine cannot render goes back to automatic.
      const nowAllowed = await (async () => {
        const provider = hits[0].provider;
        if (!wantVideo) return IMAGE_ASPECTS;
        return /grok-imagine-video/i.test(hits[0].id) ? VIDEO_ASPECTS["xai"] : VIDEO_ASPECTS[provider] ?? VIDEO_ASPECTS["leonardo"];
      })();
      if (cfg.resolution && cfg.resolution !== "auto" && !nowAllowed.includes(cfg.resolution)) patch.resolution = "auto";
      await ctx.api.saveAgentConfig(agent, patch);
      return ok(`${agent} now renders with ${hits[0].name}${patch.resolution ? " (aspect reset to auto)" : ""}.`);
    },
  },
  {
    name: "aspect",
    aliases: ["aspecto"],
    usage: "/aspect <16:9 | 9:16 | 1:1 | … | auto>",
    description: "Set the active agent's image/video aspect ratio",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const allowed = await aspectsFor(ctx, agent);
      if (!allowed) return err(`${agent} is not an image or video worker.`);
      const q = args.trim();
      if (!q) {
        const cfg = await ctx.api.getAgentConfig(agent);
        return info(`${agent}'s aspect: ${cfg.resolution || "auto"}. Available: auto, ${allowed.join(", ")}.`);
      }
      if (fold(q) !== "auto" && !allowed.includes(q)) return err(`"${q}" is not available for this engine. Use auto, ${allowed.join(", ")}.`);
      await ctx.api.saveAgentConfig(agent, { resolution: fold(q) === "auto" ? "auto" : q });
      return ok(`${agent}'s aspect is now ${fold(q) === "auto" ? "auto" : q}.`);
    },
  },
  {
    name: "tools",
    aliases: ["herramientas"],
    description: "Tools granted to the active agent",
    handler: async (ctx) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const { declared, granted } = await ctx.api.agentTools(agent);
      const unknown = declared.filter((d) => !granted.some((g) => g === d || g.startsWith(d.replace(/\s+/g, "_").toLowerCase() + "_")));
      const lines = [`${agent} can use ${granted.length} tool${granted.length === 1 ? "" : "s"}${granted.length ? ": " + granted.join(", ") : "."}`];
      // tools.md may carry prose bullets (the seed files do); keep the note short.
      if (unknown.length) {
        const shown = unknown.slice(0, 5).map((u) => (u.length > 40 ? u.slice(0, 37) + "…" : u));
        lines.push(`Declared in tools.md but matching no tool: ${shown.join(", ")}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""}.`);
      }
      lines.push("/grant <tool> · /revoke <tool> to change them.");
      return info(lines.join("\n"));
    },
  },
  {
    name: "grant",
    aliases: ["conceder"],
    usage: "/grant <tool>",
    description: "Grant a tool to the active agent (adds it to its tools.md)",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const [tool] = splitFirst(args);
      if (!tool) return err("Usage: /grant <tool>. See /tools for what the agent has.");
      const result = await ctx.api.editAgentTools(agent, { add: tool });
      if (result.error) return err(result.error);
      return ok(`${tool} granted to ${agent}. It applies from the next task.`);
    },
  },
  {
    name: "revoke",
    aliases: ["quitar"],
    usage: "/revoke <tool>",
    description: "Revoke a tool from the active agent (removes it from its tools.md)",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const [tool] = splitFirst(args);
      if (!tool) return err("Usage: /revoke <tool>. See /tools for what the agent has.");
      const result = await ctx.api.editAgentTools(agent, { remove: tool });
      if (result.error) return err(result.error);
      return ok(`${tool} revoked from ${agent}.`);
    },
  },
  {
    name: "profile",
    aliases: ["perfil", "ficha"],
    description: "Open the active agent's profile",
    uiOnly: true,
    handler: async (ctx) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      return ok(`Opening ${agent}'s profile.`, { type: "navigate", path: "/agents", query: { select: agent } });
    },
  },
  {
    name: "crons",
    aliases: ["programadas"],
    description: "List the scheduled tasks",
    handler: async (ctx) => {
      const crons = await ctx.api.listCrons();
      if (!crons.length) return info("No scheduled tasks yet. Create one with /cron <schedule> <prompt>.");
      const lines = crons.map((c) => `${c.status === "active" ? "▶" : "⏸"} ${c.name} — ${describeSchedule(c.cronExpression)} · ${c.assignedAgent ?? "auto"}`);
      return info(lines.join("\n") + "\n\n/pause <name> · /resume <name> · /run <name>");
    },
  },
  {
    name: "cron",
    aliases: ["programar"],
    usage: "/cron <schedule> <prompt>",
    description: "Schedule a task for the active agent (e.g. /cron mon-fri 09:00 resume las noticias)",
    handler: async (ctx, args) => {
      const agent = requireAgent(ctx);
      if (typeof agent !== "string") return agent;
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) return err("Usage: /cron <schedule> <prompt>. Schedules: 5m, hourly, 09:00, daily 21:00, mon-fri 09:00, lun,mie,vie 18:00, monthly 1 08:00, or a cron expression.");
      // The schedule is the longest leading phrase that parses; the rest is the prompt.
      let expr: string | null = null;
      let prompt = "";
      for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
        const candidate = parseSchedule(words.slice(0, k).join(" "));
        if (candidate) { expr = candidate; prompt = words.slice(k).join(" "); break; }
      }
      if (!expr || !prompt) return err(`Could not read a schedule at the start of "${args.trim().slice(0, 40)}…". Try 5m, hourly, 09:00, mon-fri 09:00, monthly 1 08:00, or a cron expression.`);
      const name = prompt.length > 40 ? prompt.slice(0, 37).trimEnd() + "…" : prompt;
      if (ctx.transport === "app") {
        return ok(`Opening the scheduled-task form: ${describeSchedule(expr)} · ${agent}.`, {
          type: "open_cron_form",
          prefill: { name, prompt, cronExpression: expr, assignedAgent: agent },
        });
      }
      const { id } = await ctx.api.createCron({ name, prompt, cronExpression: expr, assignedAgent: agent });
      return ok(`Scheduled "${name}" for ${agent}: ${describeSchedule(expr)} (${expr}). Id ${id.slice(0, 8)}.`);
    },
  },
  {
    name: "pause",
    aliases: ["pausar"],
    usage: "/pause <name>",
    description: "Pause a scheduled task",
    handler: async (ctx, args) => {
      const name = args.trim();
      if (!name) return err("Usage: /pause <name>. See /crons.");
      const { cron, candidates } = await findCron(ctx, name);
      if (!cron) return err(candidates.length ? `Which one? ${candidates.map((c) => c.name).join(" · ")}` : "No scheduled tasks yet.");
      if (cron.status === "paused") return info(`"${cron.name}" is already paused.`);
      await ctx.api.setCronStatus(cron.id, "paused");
      return ok(`"${cron.name}" paused.`);
    },
  },
  {
    name: "resume",
    aliases: ["reanudar"],
    usage: "/resume <name>",
    description: "Resume a paused scheduled task",
    handler: async (ctx, args) => {
      const name = args.trim();
      if (!name) return err("Usage: /resume <name>. See /crons.");
      const { cron, candidates } = await findCron(ctx, name);
      if (!cron) return err(candidates.length ? `Which one? ${candidates.map((c) => c.name).join(" · ")}` : "No scheduled tasks yet.");
      if (cron.status === "active") return info(`"${cron.name}" is already active.`);
      await ctx.api.setCronStatus(cron.id, "active");
      return ok(`"${cron.name}" resumed: ${describeSchedule(cron.cronExpression)}.`);
    },
  },
  {
    name: "run",
    aliases: ["ejecutar"],
    usage: "/run <name>",
    description: "Run a scheduled task now, without waiting for its schedule",
    handler: async (ctx, args) => {
      const name = args.trim();
      if (!name) return err("Usage: /run <name>. See /crons.");
      const { cron, candidates } = await findCron(ctx, name);
      if (!cron) return err(candidates.length ? `Which one? ${candidates.map((c) => c.name).join(" · ")}` : "No scheduled tasks yet.");
      await ctx.api.runCron(cron.id);
      return ok(`"${cron.name}" is running now. The result lands in ${cron.assignedAgent ?? "the agent"}'s chat.`);
    },
  },
  {
    name: "retry",
    aliases: ["reintentar"],
    description: "Send this chat's last message again",
    handler: async (ctx) => {
      const [last] = await ctx.api.listTasks(ctx.conversationId, 1);
      if (!last) return err("Nothing to retry in this chat.");
      const { taskId } = await ctx.api.createTask(ctx.conversationId, last.prompt, { isRead: true });
      return ok(`Sent again: "${last.prompt.replace(/\s+/g, " ").slice(0, 60)}${last.prompt.length > 60 ? "…" : ""}"`, { type: "await_task", taskId, agentId: ctx.conversationId });
    },
  },
  {
    name: "lang",
    aliases: ["idioma"],
    usage: "/lang <es | en | it | fr | pt>",
    description: "Switch the interface language",
    uiOnly: true,
    handler: async (_ctx, args) => {
      const lang = fold(args);
      if (!["es", "en", "it", "fr", "pt"].includes(lang)) return err("Usage: /lang <es | en | it | fr | pt>.");
      return ok(`Language: ${lang}.`, { type: "set_lang", lang });
    },
  },
  {
    name: "theme",
    aliases: ["tema"],
    usage: "/theme <light | dark>",
    description: "Switch the interface theme",
    uiOnly: true,
    handler: async (_ctx, args) => {
      const theme = fold(args);
      if (theme !== "light" && theme !== "dark") return err("Usage: /theme <light | dark>.");
      return ok(`Theme: ${theme}.`, { type: "set_theme", theme });
    },
  },
];


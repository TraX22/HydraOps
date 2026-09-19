// The HydraOps command layer: "/verbs" over the system that run without any
// LLM — immediate, deterministic, cheap. One registry, several transports:
// the app chat (with a palette), the Telegram bot, a CLI later. A transport
// builds a CommandContext, the API executes the command (POST /api/commands)
// and the transport renders the CommandResult, applying its `action` if it
// knows how (the app opens tabs; Telegram keeps a session; a CLI ignores it).
//
// Grew out of apps/telegram-bot/src/commands, which was written transport-
// agnostic on purpose so it could move here.

export interface AgentSummary {
  id: string;
  name: string;
  emoji?: string | null;
  status?: string;
  workerType?: string;
  model?: string;
}

export interface TaskSummary {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  agent?: string | null;
}

export interface SystemStatus {
  version: string;
  latest?: string | null;
  workers: { id: string; status: string }[];
  providers: string[];
}

export interface MemoryHit {
  date: string;
  prompt: string;
  excerpt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  type?: string;
  isImage?: boolean;
  isVideo?: boolean;
}

export interface AgentConfig {
  model: string;
  workerType?: string;
  graphicEngine?: string;
  resolution?: string;
}

export interface CronInfo {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  assignedAgent: string | null;
  status: "active" | "paused";
}

// What the transport should do after showing the text. Each transport
// applies what it can and ignores the rest.
export type CommandAction =
  | { type: "open_tab"; agentId: string }
  | { type: "main" }
  | { type: "close_tab" }
  | { type: "open_oneshot" }
  | { type: "open_threed" }
  | { type: "open_plugins" }
  | { type: "navigate"; path: string; query?: Record<string, string> }
  // The app opens the scheduled-task form pre-filled for the user to confirm.
  | { type: "open_cron_form"; prefill: { name: string; prompt: string; cronExpression: string; assignedAgent: string } }
  | { type: "set_lang"; lang: string }
  | { type: "set_theme"; theme: string }
  // A task was created for an agent; a synchronous transport (Telegram)
  // waits for it and relays the reply.
  | { type: "await_task"; taskId: string; agentId: string };

export interface CommandResult {
  text: string;
  kind?: "info" | "ok" | "error";
  action?: CommandAction;
}

// Catalog entry: what the palette and /help show. `description` is the
// English fallback; the app translates by `commands.<name>` in its locales.
export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage?: string;
  description: string;
  // Only meaningful with a UI (open a canvas, close a tab); other
  // transports answer with a note instead of running it.
  uiOnly?: boolean;
}

export interface Command extends CommandSpec {
  handler(ctx: CommandContext, args: string): Promise<CommandResult>;
}

// Everything a command may ask of HydraOps. Implemented once, by the API.
export interface CommandApi {
  listAgents(): Promise<AgentSummary[]>;
  createTask(agentId: string, prompt: string, opts?: { isRead?: boolean }): Promise<{ taskId: string }>;
  listTasks(channel: string, limit: number): Promise<TaskSummary[]>;
  systemStatus(): Promise<SystemStatus>;
  remember(agentId: string, text: string): Promise<string>;
  recall(agentId: string, query: string): Promise<MemoryHit[]>;
  readMemory(agentId: string): Promise<string>;
  sendTelegram(text: string): Promise<{ ok: boolean; sent?: number; reason?: string; error?: string }>;
  // Phase 2
  listModels(): Promise<ModelInfo[]>;
  getAgentConfig(agentId: string): Promise<AgentConfig>;
  saveAgentConfig(agentId: string, patch: Partial<AgentConfig>): Promise<void>;
  agentTools(agentId: string): Promise<{ declared: string[]; granted: string[] }>;
  /** Add or remove one bullet in the agent's tools.md; `error` when the name matches no tool. */
  editAgentTools(agentId: string, change: { add?: string; remove?: string }): Promise<{ declared: string[]; error?: string }>;
  listCrons(): Promise<CronInfo[]>;
  createCron(cron: { name: string; prompt: string; cronExpression: string; assignedAgent: string }): Promise<{ id: string }>;
  setCronStatus(id: string, status: "active" | "paused"): Promise<void>;
  runCron(id: string): Promise<void>;
}

export interface CommandContext {
  transport: "app" | "telegram" | "cli";
  /** Stable id of whoever issued the command (e.g. "tg:12345", "app"). */
  senderId: string;
  /** The conversation the command belongs to: a chat channel in the app, a chat id in Telegram. */
  conversationId: string;
  /** The agent this conversation talks to, if any (app: the agent tab; Telegram: the session). */
  activeAgent?: string;
  api: CommandApi;
}

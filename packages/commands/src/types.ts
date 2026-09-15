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

// What the transport should do after showing the text. Each transport
// applies what it can and ignores the rest.
export type CommandAction =
  | { type: "open_tab"; agentId: string }
  | { type: "main" }
  | { type: "close_tab" }
  | { type: "open_oneshot" }
  | { type: "navigate"; path: string; query?: Record<string, string> }
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

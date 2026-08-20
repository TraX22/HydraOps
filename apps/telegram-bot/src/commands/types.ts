// Transport-agnostic command layer.
//
// This is the seed of a future global HydraOps command system: nothing here
// knows about Telegram. A transport (Telegram today; an in-app console or a CLI
// tomorrow) builds a CommandContext and renders the CommandResult. When the
// global system lands, move this `commands/` folder to a shared package
// (@hydraops/commands) without touching the core, and have each transport import
// it.

export interface AgentSummary {
  id: string;
  name: string;
  emoji?: string;
  status?: string;
}

// Everything a command needs, provided by the transport. Keep it free of any
// transport-specific types so the same commands run anywhere.
export interface CommandContext {
  /** Stable id of whoever issued the command (e.g. "tg:12345"). */
  senderId: string;
  /** The conversation/thread the command belongs to (e.g. a Telegram chat id). */
  conversationId: string;
  /** The agent this conversation is currently talking to, if any. */
  session: {
    get(): string | undefined;
    set(agentId: string | undefined): Promise<void>;
  };
  /** Bridge to HydraOps. */
  api: {
    listAgents(): Promise<AgentSummary[]>;
    hasAgent(agentId: string): Promise<boolean>;
    /** Send a prompt to an agent and resolve with its reply text. */
    sendToAgent(agentId: string, prompt: string): Promise<string>;
  };
  /** Fallback agent when the conversation has no active one. */
  defaultAgent?: string;
}

export interface CommandResult {
  text: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler(ctx: CommandContext, args: string): Promise<CommandResult>;
}

import { z } from "zod";
import type { ReportedFile } from "./result-files.js";
import type { ToolRisk } from "./provenance.js";

// An add-on that needs an API key declares it here. The UI (Addons section)
// renders a field to enter it; the real key lives in the key store and travels
// through the key-proxy — the worker never sees it. `configField` is the key of
// the POST /config contract (e.g. 'braveKey'); `keyName` is the keystore ENV
// (e.g. 'BRAVE_API_KEY').
export interface ToolKeyRequirement {
  configField: string;
  keyName: string;
  label: string;
  helpUrl?: string;
}

// One past-task match handed back by the worker-bound episodic search (see the
// `recall` native tool). Mirrors RecallHit in @hydraops/db without importing it,
// so this package stays independent of the database.
export interface PastTaskHit {
  taskId: string;
  date: string; // YYYY-MM-DD
  prompt: string;
  excerpt: string;
  // That past task had read outside content: its text is third-party-influenced.
  tainted?: boolean;
}

// Per-task context a worker binds to the tools it hands the model. The model
// never fills these values — they identify WHO is running, so a tool like
// `remember` can act on the calling agent without trusting model input.
export interface ToolContext {
  agentId?: string;
  // Full-text search over THIS agent's completed tasks. The worker binds the
  // agent identity into the closure, so the model only ever supplies keywords.
  searchPastTasks?: (query: string, limit?: number) => PastTaskHit[] | Promise<PastTaskHit[]>;
  // Prompt-injection defense (see provenance.ts). `external` marks the task as having
  // read third-party text that arrived by another road than a tool result, and returns
  // that text wrapped as data; `taintOrigins` tells a tool (delegate_task) where the
  // task's outside content came from, so it can pass the taint on.
  external?: (toolName: string, ref: string | undefined, content: string) => string;
  taintOrigins?: () => { tool: string; ref?: string }[];
  // This task's own folder (storage/results/<task>): where a tool leaves a file the agent
  // will hand to another tool or to the user.
  filesDir?: string;
  // Where the files the user attached are stored (storage/uploads): a tool resolves an
  // attachment the conversation names, the model never needs the folder itself.
  uploadsDir?: string;
  // The environment a connection (an MCP server entry) is configured with, by the server's
  // name: a native tool that works next to a connection reads the same address the user
  // set there instead of asking for it twice.
  connectionEnv?: (serverName: string) => Record<string, string>;
  // A file this tool left for the user in the task's folder (see result-files.ts): the
  // worker stores it with the task's result and the chat shows it next to the answer.
  addResultFile?: (file: ReportedFile) => void;
}

export interface HydraTool {
  name: string;
  // Display name for the UI (e.g. "Web Search"); `name` stays the technical id
  // the gate, tools.md and the model use. Falls back to `name` when absent.
  title?: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: any, context?: ToolContext) => Promise<any>;
  source?: 'native' | 'my_addons';
  requiresKey?: ToolKeyRequirement;
  // What the tool can do, for the prompt-injection defense (see provenance.ts).
  // A user add-on that declares nothing is treated as the worst case.
  // A function when it depends on the arguments (e.g. GET vs POST).
  risk?: ToolRisk | ((args: any) => ToolRisk);
  // False for a tool whose result is instructions the model must get whole (an installed
  // skill): it is neither digested into the task vault nor cut. The tool caps itself.
  vault?: false;
}

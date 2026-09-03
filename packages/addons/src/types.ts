import { z } from "zod";

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

// Per-task context a worker binds to the tools it hands the model. The model
// never fills these values — they identify WHO is running, so a tool like
// `remember` can act on the calling agent without trusting model input.
export interface ToolContext {
  agentId?: string;
}

export interface HydraTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: any, context?: ToolContext) => Promise<any>;
  source?: 'native' | 'my_addons';
  requiresKey?: ToolKeyRequirement;
}

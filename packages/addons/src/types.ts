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

export interface HydraTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: any) => Promise<any>;
  source?: 'native' | 'my_addons';
  requiresKey?: ToolKeyRequirement;
}

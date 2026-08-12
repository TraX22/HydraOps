import { z } from "zod";

export interface HydraTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: any) => Promise<any>;
  source?: 'native' | 'my_addons';
}

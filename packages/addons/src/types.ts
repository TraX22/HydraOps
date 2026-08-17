import { z } from "zod";

// Un add-on que necesita una API-key la declara aquí. La UI (sección Addons)
// pinta un campo para ingresarla; la key real vive en el almacén de claves y
// viaja por el key-proxy — el worker nunca la ve. `configField` es la clave del
// contrato POST /config (p. ej. 'braveKey'); `keyName` es el ENV del keystore
// (p. ej. 'BRAVE_API_KEY').
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

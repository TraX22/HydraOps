# my_addons — Add-ons personalizados

Cada add-on vive en su propia carpeta con un `index.ts` que exporta uno o más
objetos con esta forma (la interfaz `HydraTool` de `@hydraops/addons`):

```ts
import { z } from "zod";

export const miTool = {
  name: "mi_tool",                        // snake_case, único
  description: "Qué hace (el LLM la lee para decidir usarla)",
  schema: z.object({                      // parámetros que el LLM debe pasar
    texto: z.string().describe("Descripción del parámetro"),
  }),
  execute: async ({ texto }: { texto: string }) => {
    return `resultado: ${texto}`;         // string o JSON.stringify(...)
  },
};
```

Estructura:

```
my_addons/
  get_current_time/
    index.ts
  mi_otro_addon/
    index.ts
```

- Se cargan automáticamente al arrancar los workers (worker-general y
  worker-coder). Tras añadir o editar un add-on, reinicia los workers.
- Aparecen en la vista **Add-ons** de la UI con su toggle ON/OFF, igual que
  los nativos.
- Los agentes con `tools.md` vacío reciben todos los add-ons activos; si el
  archivo lista herramientas (`- mi_tool`), solo reciben esas.
- Dependencias: `zod` ya está disponible. Si tu add-on necesita otra librería,
  añádela a la raíz del monorepo: `pnpm add -w <paquete>`.

import { z } from "zod";
import { HydraTool } from "../../../types.js";

// brave_search — búsqueda web vía Brave Search API.
//
// Add-on independiente de web_search (que usa DuckDuckGo). La API key real
// NUNCA la ve el worker: la petición sale hacia el key-proxy local
// (KEY_PROXY_URL, p. ej. http://127.0.0.1:9099) bajo el prefijo /brave/…, y el
// proxy inyecta el header X-Subscription-Token con la key guardada en el
// almacén de claves. Misma arquitectura que los proveedores LLM. La key se
// ingresa en la sección Addons (ver `requiresKey` abajo).

const MAX_RESULTS = 8;
const MAX_SNIPPET = 300;

// Enruta la llamada por el key-proxy si KEY_PROXY_URL está configurado.
// Sin proxy no hay forma segura de autenticar (el worker no tiene la key).
function proxiedBrave(path: string): string | null {
  const proxyBase = (process.env.KEY_PROXY_URL || "").trim().replace(/\/$/, "");
  if (!proxyBase) return null;
  return `${proxyBase}/brave${path}`;
}

async function searchBrave(query: string): Promise<string> {
  console.log(`[Tool: BraveSearch] Searching for: ${query}`);

  const path = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const url = proxiedBrave(path);
  if (!url) {
    return "brave_search no está disponible: falta el key-proxy (KEY_PROXY_URL). No se puede autenticar la búsqueda de forma segura.";
  }

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (response.status === 401) {
      return "brave_search: no hay API key de Brave configurada. Añádela en la sección Addons → Brave Search para habilitar la búsqueda web.";
    }
    if (response.status === 429) {
      return "brave_search: límite de peticiones de Brave alcanzado (rate limit). Prueba de nuevo en unos segundos.";
    }
    if (!response.ok) {
      return `brave_search: error del proveedor (HTTP ${response.status}).`;
    }

    const data: any = await response.json();
    const raw = Array.isArray(data?.web?.results) ? data.web.results : [];
    const results = raw.slice(0, MAX_RESULTS).map((r: any) => ({
      title: (r.title || "").trim(),
      link: r.url || "",
      snippet: (r.description || "").replace(/<\/?[^>]+>/g, "").trim().slice(0, MAX_SNIPPET),
    })).filter((r: any) => r.title && r.link);

    return results.length > 0 ? JSON.stringify(results, null, 2) : "No results found.";
  } catch (e: any) {
    return `Search error: ${e.message}`;
  }
}

export const braveSearchTool: HydraTool = {
  name: "brave_search",
  description:
    "Search the web using the Brave Search API. Reliable web results when you need recent or verifiable information.",
  schema: z.object({
    query: z.string().describe("The search term or phrase"),
  }),
  execute: async ({ query }) => await searchBrave(query),
  requiresKey: {
    configField: "braveKey",
    keyName: "BRAVE_API_KEY",
    label: "Brave Search API key",
    helpUrl: "https://brave.com/search/api",
  },
};

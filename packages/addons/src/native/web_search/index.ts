import { z } from "zod";
import { HydraTool } from "../../../types.js";

// web_search — búsqueda web vía Brave Search API.
//
// La API key real NUNCA la ve el worker: la petición sale hacia el key-proxy
// local (KEY_PROXY_URL, p. ej. http://127.0.0.1:9099) bajo el prefijo /brave/…,
// y el proxy inyecta el header X-Subscription-Token con la key guardada en el
// almacén de claves. El worker solo conoce el placeholder. Misma arquitectura
// que los proveedores LLM.

const MAX_RESULTS = 8;
const MAX_SNIPPET = 300;
const BRAVE_HOST = "https://api.search.brave.com";

// Enruta la llamada por el key-proxy si KEY_PROXY_URL está configurado.
// Sin proxy no hay forma segura de autenticar (el worker no tiene la key),
// así que se exige el firewall.
function proxiedBrave(path: string): string | null {
  const proxyBase = (process.env.KEY_PROXY_URL || "").trim().replace(/\/$/, "");
  if (!proxyBase) return null;
  return `${proxyBase}/brave${path}`;
}

async function searchWeb(query: string): Promise<string> {
  console.log(`[Tool: WebSearch] Searching (Brave) for: ${query}`);

  const path = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const url = proxiedBrave(path);
  if (!url) {
    return "web_search no está disponible: falta el key-proxy (KEY_PROXY_URL). No se puede autenticar la búsqueda de forma segura.";
  }

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (response.status === 401) {
      return "web_search: no hay API key de Brave configurada. Añádela en Configuración → Brave Search para habilitar la búsqueda web.";
    }
    if (response.status === 429) {
      return "web_search: límite de peticiones de Brave alcanzado (rate limit). Prueba de nuevo en unos segundos.";
    }
    if (!response.ok) {
      return `web_search: error del proveedor (HTTP ${response.status}).`;
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

export const webSearchTool: HydraTool = {
  name: "web_search",
  description:
    "Search for updated information on the internet when you do not have the answer or need recent data.",
  schema: z.object({
    query: z.string().describe("The search term or phrase"),
  }),
  execute: async ({ query }) => await searchWeb(query),
};

// Host real, expuesto para tests/documentación del enrutado por el proxy.
export const BRAVE_SEARCH_HOST = BRAVE_HOST;

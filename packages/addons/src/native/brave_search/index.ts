import { z } from "zod";
import { HydraTool } from "../../../types.js";

// brave_search — búsqueda web vía Brave Search API.
//
// Add-on independiente de web_search (que usa DuckDuckGo). La API key real
// NUNCA la ve el worker: la petición sale hacia el key-proxy local
// (KEY_PROXY_URL) bajo el prefijo /brave/…, y el proxy inyecta el header
// X-Subscription-Token con la key del almacén de claves. La key se ingresa en
// la sección Addons (ver `requiresKey` abajo).
//
// Región: la API de Brave NO usa la IP de quien llama (por defecto asume US),
// así que replicamos lo que hace DuckDuckGo — detectamos el país de la IP de
// salida y lo pasamos como `country` (relevancia regional, NO filtro de idioma;
// nunca se fija `search_lang`, para no encerrar los resultados en un idioma).

const MAX_RESULTS = 8;
const MAX_SNIPPET = 300;

// Convierte el HTML del snippet de Brave en texto plano. Los snippets traen
// etiquetas de resaltado (<strong>…); las quitamos en bucle hasta que la cadena
// se estabiliza (un único replace es evadible — "bad tag filter") y eliminamos
// cualquier ángulo residual: el snippet es texto para el modelo, nunca HTML.
function stripHtml(input: string): string {
  let out = input;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out.replace(/[<>]/g, "");
}

// Enruta la llamada por el key-proxy si KEY_PROXY_URL está configurado.
function proxiedBrave(path: string): string | null {
  const proxyBase = (process.env.KEY_PROXY_URL || "").trim().replace(/\/$/, "");
  if (!proxyBase) return null;
  return `${proxyBase}/brave${path}`;
}

// País de la IP de salida, cacheado (la región no cambia a menudo). Cloudflare
// trace primero (HTTPS, sin key, rápido); ipapi.co como reserva.
let cachedCountry: string | null = null;
let countryResolvedAt = 0;
const COUNTRY_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

async function detectCountry(): Promise<string | null> {
  const now = Date.now();
  if (cachedCountry && now - countryResolvedAt < COUNTRY_TTL_MS) return cachedCountry;

  const set = (c: string) => { cachedCountry = c.toUpperCase(); countryResolvedAt = now; return cachedCountry; };
  try {
    const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const m = (await r.text()).match(/^loc=([A-Z]{2})$/m);
      if (m) return set(m[1]);
    }
  } catch { /* siguiente */ }
  try {
    const r = await fetch("https://ipapi.co/country/", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const c = (await r.text()).trim();
      if (/^[A-Za-z]{2}$/.test(c)) return set(c);
    }
  } catch { /* sin geo → sin country */ }
  return null;
}

async function searchBrave(query: string, countryOverride?: string): Promise<string> {
  // País: el que pida el agente, o el auto-detectado por IP (como DuckDuckGo).
  const country = (countryOverride || (await detectCountry()) || "").toUpperCase();
  const geoSuffix = /^[A-Z]{2}$/.test(country) ? `&country=${country}` : "";
  console.log(`[Tool: BraveSearch] Searching for: ${query}${geoSuffix ? ` (country=${country})` : ""}`);

  const path = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}${geoSuffix}`;
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
      snippet: stripHtml(r.description || "").trim().slice(0, MAX_SNIPPET),
    })).filter((r: any) => r.title && r.link);

    return results.length > 0 ? JSON.stringify(results, null, 2) : "No results found.";
  } catch (e: any) {
    return `Search error: ${e.message}`;
  }
}

export const braveSearchTool: HydraTool = {
  name: "brave_search",
  description:
    "Search the web using the Brave Search API. Reliable web results when you need recent or verifiable information. Results are biased to the server's region automatically; pass `country` to target another region.",
  schema: z.object({
    query: z.string().describe("The search term or phrase"),
    country: z
      .string()
      .length(2)
      .optional()
      .describe("Optional 2-letter country code (e.g. 'US', 'AR', 'ES') to bias regional relevance. Defaults to the server's detected region."),
  }),
  execute: async ({ query, country }) => await searchBrave(query, country),
  requiresKey: {
    configField: "braveKey",
    keyName: "BRAVE_API_KEY",
    label: "Brave Search API key",
    helpUrl: "https://brave.com/search/api",
  },
};

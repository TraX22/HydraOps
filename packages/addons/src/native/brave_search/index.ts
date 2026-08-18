import { z } from "zod";
import { HydraTool } from "../../../types.js";

// brave_search — web search via the Brave Search API.
//
// Independent add-on from web_search (which uses DuckDuckGo). The real API key
// is NEVER seen by the worker: the request goes to the local key-proxy
// (KEY_PROXY_URL) under the /brave/… prefix, and the proxy injects the
// X-Subscription-Token header with the key from the key store. The key is
// entered in the Addons section (see `requiresKey` below).
//
// Region: the Brave API does NOT use the caller's IP (it defaults to US), so we
// replicate what DuckDuckGo does — detect the country of the egress IP and pass
// it as `country` (regional relevance, NOT a language filter; `search_lang` is
// never set, so results aren't locked to a single language).

const MAX_RESULTS = 8;
const MAX_SNIPPET = 300;

// Turns Brave's HTML snippet into plain text. Snippets carry highlight tags
// (<strong>…); we strip them in a loop until the string stabilises (a single
// replace is bypassable — "bad tag filter") and drop any leftover angle
// brackets: the snippet is text for the model, never HTML.
function stripHtml(input: string): string {
  let out = input;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out.replace(/[<>]/g, "");
}

// Route the call through the key-proxy if KEY_PROXY_URL is configured.
function proxiedBrave(path: string): string | null {
  const proxyBase = (process.env.KEY_PROXY_URL || "").trim().replace(/\/$/, "");
  if (!proxyBase) return null;
  return `${proxyBase}/brave${path}`;
}

// Country of the egress IP, cached (the region doesn't change often). Cloudflare
// trace first (HTTPS, no key, fast); ipapi.co as a fallback.
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
  } catch { /* try next */ }
  try {
    const r = await fetch("https://ipapi.co/country/", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const c = (await r.text()).trim();
      if (/^[A-Za-z]{2}$/.test(c)) return set(c);
    }
  } catch { /* no geo → no country */ }
  return null;
}

async function searchBrave(query: string, countryOverride?: string): Promise<string> {
  // Country: the one the agent asks for, or the IP-detected one (like DuckDuckGo).
  const country = (countryOverride || (await detectCountry()) || "").toUpperCase();
  const geoSuffix = /^[A-Z]{2}$/.test(country) ? `&country=${country}` : "";
  console.log(`[Tool: BraveSearch] Searching for: ${query}${geoSuffix ? ` (country=${country})` : ""}`);

  const path = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}${geoSuffix}`;
  const url = proxiedBrave(path);
  if (!url) {
    return "brave_search is unavailable: the key-proxy (KEY_PROXY_URL) is missing. The search cannot be authenticated securely.";
  }

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (response.status === 401) {
      return "brave_search: no Brave API key is configured. Add it in the Addons section → Brave Search to enable web search.";
    }
    if (response.status === 429) {
      return "brave_search: Brave request limit reached (rate limit). Try again in a few seconds.";
    }
    if (!response.ok) {
      return `brave_search: provider error (HTTP ${response.status}).`;
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

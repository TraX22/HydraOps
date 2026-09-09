import { z } from "zod";
import { HydraTool } from "../../../types.js";

// perplexity_search — AI-powered web search via the Perplexity Sonar API.
//
// Unlike web_search/brave_search (raw result lists), Perplexity returns a
// SYNTHESIZED answer grounded in a live web search, plus the sources it used.
// The real API key is NEVER seen by the worker: the request goes to the local
// key-proxy (KEY_PROXY_URL) under the /perplexity/… prefix and the proxy
// injects the Authorization header. The key is entered in the Addons section
// (see `requiresKey` below).

const MODEL = "sonar";
const MAX_ANSWER = 3500;
const MAX_SOURCES = 8;

function proxiedPerplexity(path: string): string | null {
  const proxyBase = (process.env.KEY_PROXY_URL || "").trim().replace(/\/$/, "");
  if (!proxyBase) return null;
  return `${proxyBase}/perplexity${path}`;
}

async function askPerplexity(query: string, recency?: string): Promise<string> {
  const url = proxiedPerplexity("/chat/completions");
  if (!url) {
    return "perplexity_search is unavailable: the key-proxy (KEY_PROXY_URL) is missing. The request cannot be authenticated securely.";
  }
  console.log(`[Tool: Perplexity] Asking: ${query}${recency ? ` (recency=${recency})` : ""}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: query }],
        ...(recency ? { search_recency_filter: recency } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (response.status === 401) {
      return "perplexity_search: no Perplexity API key is configured. Add it in the Addons section → Perplexity to enable it.";
    }
    if (response.status === 429) {
      return "perplexity_search: Perplexity request limit reached (rate limit). Try again in a few seconds.";
    }
    if (!response.ok) {
      return `perplexity_search: provider error (HTTP ${response.status}).`;
    }

    const data: any = await response.json();
    const answer = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!answer) return "perplexity_search: empty answer from the provider.";

    // Sources: newer API revisions ship `search_results` ({title,url}); older
    // ones only `citations` (plain URLs). Accept either.
    const results = Array.isArray(data?.search_results) ? data.search_results : [];
    const citations = Array.isArray(data?.citations) ? data.citations : [];
    const sources: string[] = results.length
      ? results.slice(0, MAX_SOURCES).map((r: any, i: number) =>
          `${i + 1}. ${String(r?.title || "").trim() || r?.url || ""}${r?.title && r?.url ? ` — ${r.url}` : ""}`)
      : citations.slice(0, MAX_SOURCES).map((c: any, i: number) => `${i + 1}. ${String(c)}`);

    return sources.length
      ? `${answer.slice(0, MAX_ANSWER)}\n\nSources:\n${sources.join("\n")}`
      : answer.slice(0, MAX_ANSWER);
  } catch (e: any) {
    return `perplexity_search error: ${e.message}`;
  }
}

export const perplexitySearchTool: HydraTool = {
  name: "perplexity_search",
  description:
    "Ask Perplexity (Sonar): AI-powered web search that returns a synthesized, up-to-date answer with source citations. Best when you need current information reasoned into one answer; use web_search or brave_search when you want a raw list of links instead.",
  schema: z.object({
    query: z.string().describe("The question or topic to research, phrased as a full question for best results"),
    recency: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Optional: restrict the underlying web search to results from the last day/week/month/year"),
  }),
  execute: async ({ query, recency }) => await askPerplexity(query, recency),
  requiresKey: {
    configField: "perplexityKey",
    keyName: "PERPLEXITY_API_KEY",
    label: "Perplexity API key",
    helpUrl: "https://www.perplexity.ai/settings/api",
  },
};

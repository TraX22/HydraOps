import { z } from "zod";
import { HydraTool } from "../../types.js";

const ENGINE = "DuckDuckGo";
const MAX_RESULTS = 5;

export type SearchPage =
  | { kind: "results"; results: { title: string; link: string; snippet: string }[] }
  | { kind: "none" }
  | { kind: "blocked"; status: number }
  | { kind: "http_error"; status: number }
  | { kind: "unreadable" };

// What tells the model that nothing was searched, in every failure message: a model that
// reads "no results" concludes the thing does not exist, or answers from memory as if it
// had looked.
const NOT_SEARCHED =
  'This is NOT "no results": nothing was searched. Do not conclude that the information does not exist, and do not answer as if you had searched.';
const WHAT_NOW =
  "Use another search tool if you have one, open a page you already know with fetch_url, or tell the user that web search is not working right now.";

/**
 * Reads what DuckDuckGo's HTML endpoint answered. When it suspects automated traffic it
 * answers HTTP 202 with an "anomaly" challenge page instead of results; that page has no
 * result blocks, and used to be reported as "No results found".
 */
export async function readSearchPage(status: number, html: string): Promise<SearchPage> {
  const lower = html.toLowerCase();
  const challenged = lower.includes("anomaly-modal") || lower.includes("anomaly.js") || lower.includes("bots use duckduckgo");
  if (status === 202 || status === 403 || status === 429 || challenged) return { kind: "blocked", status };
  if (status < 200 || status >= 300) return { kind: "http_error", status };

  const cheerio = await import("cheerio");
  const $ = cheerio.load(html);
  const results: { title: string; link: string; snippet: string }[] = [];
  $(".result__body").each((i, el) => {
    if (results.length >= MAX_RESULTS) return;
    const title = $(el).find(".result__title").text().trim();
    const link = $(el).find(".result__a").attr("href");
    const snippet = $(el).find(".result__snippet").text().trim();
    if (title && link) results.push({ title, link, snippet });
  });
  if (results.length) return { kind: "results", results };
  // A real "nothing found" page says so; an empty page that does not is one we could not read.
  return $(".no-results").length > 0 ? { kind: "none" } : { kind: "unreadable" };
}

/** What the model is told for each outcome. */
export function searchPageMessage(page: SearchPage, query: string): string {
  switch (page.kind) {
    case "results":
      return JSON.stringify(page.results, null, 2);
    case "none":
      return `No results found for "${query}". Try other words.`;
    case "blocked":
      return `SEARCH BLOCKED: ${ENGINE} refused this request (HTTP ${page.status}): it is challenging or rate-limiting this connection, which usually lasts a few minutes. ${NOT_SEARCHED} ${WHAT_NOW}`;
    case "http_error":
      return `SEARCH FAILED: ${ENGINE} answered HTTP ${page.status}. ${NOT_SEARCHED} ${WHAT_NOW}`;
    case "unreadable":
      return `SEARCH FAILED: the results page of ${ENGINE} could not be read (its layout changed, or the request was challenged). ${NOT_SEARCHED} ${WHAT_NOW}`;
  }
}

async function searchWeb(query: string) {
  console.log(`[Tool: WebSearch] Searching for: ${query}`);
  let status: number, html: string;
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    status = response.status;
    html = await response.text();
  } catch (e: any) {
    console.warn(`[Tool: WebSearch] could not reach ${ENGINE}: ${e?.message ?? e}`);
    return `SEARCH FAILED: could not reach ${ENGINE} (${e?.message ?? "network error"}). ${NOT_SEARCHED} ${WHAT_NOW}`;
  }
  const page = await readSearchPage(status, html);
  if (page.kind !== "results" && page.kind !== "none") console.warn(`[Tool: WebSearch] ${page.kind} (HTTP ${status}) for: ${query}`);
  return searchPageMessage(page, query);
}

export const webSearchTool: HydraTool = {
  name: "web_search",
  risk: { readsExternal: true },
  title: "Web Search",
  description:
    "Search for updated information on the internet when you do not have the answer or need recent data. If it answers SEARCH BLOCKED or SEARCH FAILED, nothing was searched: say so, do not treat it as no results.",
  schema: z.object({
    query: z.string().describe("The search term or phrase"),
  }),
  execute: async ({ query }) => await searchWeb(query),
};

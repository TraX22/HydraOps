import { z } from "zod";
import { HydraTool } from "../../../types.js";

async function searchWeb(query: string) {
  try {
    const cheerio = await import("cheerio");
    console.log(`[Tool: WebSearch] Searching for: ${query}`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error("Error searching DuckDuckGo");

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: any[] = [];

    $(".result__body").each((i, el) => {
      if (i < 5) {
        const title = $(el).find(".result__title").text().trim();
        const link = $(el).find(".result__a").attr("href");
        const snippet = $(el).find(".result__snippet").text().trim();
        if (title && link) results.push({ title, link, snippet });
      }
    });

    return results.length > 0
      ? JSON.stringify(results, null, 2)
      : "No results found.";
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

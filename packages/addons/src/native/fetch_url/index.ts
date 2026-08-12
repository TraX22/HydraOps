import net from "node:net";
import { Agent } from "undici";
import { z } from "zod";
import { HydraTool } from "../../../types.js";
import { assertPublicUrl } from "../../guard.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const MAX_OUTPUT = 4000;

// Redirecciones seguidas a mano para poder validar CADA salto contra el guard
// SSRF — un redirect a 127.0.0.1/red privada no debe colarse.
async function fetchText(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      // La IP la fija el guard tras validarla; el dispatcher obliga a conectar a
      // ESA dirección (conservando el host para SNI/certificado) en vez de
      // re-resolver el DNS — cierra el rebinding TOCTOU. Un Agent por salto para
      // que cada IP fijada sea la de su host.
      const pinnedIp = await assertPublicUrl(current);
      const dispatcher = new Agent({
        connect: {
          lookup: (_hostname, _opts, cb) =>
            cb(null, [{ address: pinnedIp, family: net.isIPv6(pinnedIp) ? 6 : 4 }]),
        },
      });
      let response;
      try {
        response = await fetch(current, {
          headers: { "User-Agent": UA },
          signal: ctrl.signal,
          redirect: "manual",
          // @ts-expect-error dispatcher es opción de undici, no está en los tipos DOM
          dispatcher,
        });
      } finally {
        dispatcher.close().catch(() => { /* ignore */ });
      }
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        current = new URL(location, current).href;
        continue;
      }
      const body = await response.text();
      return { ok: response.ok, status: response.status, body, contentType: response.headers.get("content-type") ?? "" };
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeFeed(body: string, contentType: string): boolean {
  return /rss|atom|xml/i.test(contentType) || /<(rss|feed)[\s>]/i.test(body.slice(0, 2000));
}

// RSS 2.0 (<item>) and Atom (<entry>) → markdown list with title, date, link, summary.
async function feedToMarkdown(xml: string): Promise<string | null> {
  const cheerio = await import("cheerio");
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = $("item, entry").toArray().slice(0, 12);
  if (items.length === 0) return null;
  const feedTitle = $("channel > title, feed > title").first().text().trim();
  const lines = items.map((el) => {
    const $el = $(el);
    const title = $el.find("title").first().text().trim();
    const linkEl = $el.find("link").first();
    const link = (linkEl.attr("href") || linkEl.text()).trim();
    const date = $el.find("pubDate, published, updated").first().text().trim();
    const desc = $el
      .find("description, summary")
      .first()
      .text()
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return `- **${title}**${date ? ` (${date})` : ""}${link ? `\n  ${link}` : ""}${desc ? `\n  ${desc}` : ""}`;
  });
  return `# ${feedTitle || "Feed"}\n\n${lines.join("\n")}`;
}

// Feed URLs: declared <link rel="alternate" type="...rss/atom..."> first, then common paths.
function feedCandidates($: any, pageUrl: string): string[] {
  const urls: string[] = [];
  $('link[rel="alternate"]').each((_: number, el: any) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const href = $(el).attr("href");
    if (href && /rss|atom|xml/.test(type)) {
      try {
        urls.push(new URL(href, pageUrl).href);
      } catch { /* href inválido */ }
    }
  });
  const u = new URL(pageUrl);
  const base = u.href.endsWith("/") ? u.href : u.href + "/";
  urls.push(
    new URL("feed", base).href,
    new URL("rss.xml", base).href,
    `${u.origin}/feed`,
    `${u.origin}/rss.xml`,
    `${u.origin}/atom.xml`,
    `${u.origin}/index.xml`,
  );
  if (!u.hostname.startsWith("blog.")) {
    const apex = u.hostname.split(".").slice(-2).join(".");
    urls.push(`https://blog.${apex}/feed`, `https://blog.${apex}/rss.xml`);
  }
  return [...new Set(urls)].filter((c) => c !== pageUrl);
}

async function tryFeeds(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const r = await fetchText(candidate, 8000);
      if (!r.ok || !looksLikeFeed(r.body, r.contentType)) continue;
      const md = await feedToMarkdown(r.body);
      if (md) {
        console.log(`[Tool: FetchURL] Using RSS/Atom feed: ${candidate}`);
        return md;
      }
    } catch { /* siguiente candidato */ }
  }
  return null;
}

async function scrapeWeb(url: string) {
  try {
    const cheerio = await import("cheerio");
    const TurndownService = (await import("turndown")).default;
    console.log(`[Tool: FetchURL] Reading: ${url}`);
    let response = await fetchText(url, 20000);

    if (response.status === 404 && !url.endsWith("/")) {
      console.log(`[Tool: FetchURL] 404 detected, retrying with trailing slash: ${url}/`);
      response = await fetchText(url + "/", 20000);
    }

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    // La URL ya es un feed RSS/Atom → devolverlo formateado, no como HTML.
    if (looksLikeFeed(response.body, response.contentType)) {
      const feedMd = await feedToMarkdown(response.body);
      if (feedMd) return feedMd.slice(0, MAX_OUTPUT);
    }

    const html = response.body;
    const $ = cheerio.load(html);
    const candidates = feedCandidates($, url);

    $("script, style, nav, footer, header, ads, iframe, .ads, .sidebar").remove();

    const turndown = new TurndownService();
    const markdown = turndown.turndown($.html());

    // HTML enorme pero casi sin texto extraíble → página renderizada con JavaScript;
    // el HTML estático puede mostrar contenido viejo pre-renderizado. Buscar un feed.
    const jsRendered = markdown.length < 3000 && html.length > 20 * markdown.length;
    if (jsRendered) {
      console.log(`[Tool: FetchURL] Page looks JS-rendered (${html.length} B html → ${markdown.length} B text). Trying feeds...`);
      const feedMd = await tryFeeds(candidates);
      if (feedMd) {
        return (
          `⚠️ Esta página se renderiza con JavaScript y su HTML estático está desactualizado. ` +
          `En su lugar se leyó el feed RSS del sitio (contenido real y actual):\n\n${feedMd}`
        ).slice(0, MAX_OUTPUT);
      }
      return (
        markdown.slice(0, MAX_OUTPUT - 400) +
        `\n\n⚠️ AVISO: esta página se renderiza con JavaScript y el contenido extraído puede estar ` +
        `incompleto o DESACTUALIZADO. No lo presentes como "lo último" sin advertirlo. ` +
        `Si necesitas contenido actual, usa web_search.`
      );
    }

    return markdown.slice(0, MAX_OUTPUT);
  } catch (e: any) {
    return `Error reading URL: ${e.message}`;
  }
}

export const fetchUrlTool: HydraTool = {
  name: "fetch_url",
  description:
    "Extracts the content of a specific web page (blog, article, documentation) and returns it in Markdown format. Also reads RSS/Atom feeds, and falls back to the site's feed when the page is JavaScript-rendered.",
  schema: z.object({
    url: z.string().url().describe("The full URL of the site to read"),
  }),
  execute: async ({ url }) => await scrapeWeb(url),
};

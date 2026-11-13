import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { docsDir } from "@hydraops/config";
import { HydraTool } from "../../types.js";

// hydraops_docs — the manual that ships with the app (the Docs view), for the agents: how
// HydraOps itself works, as documented for the version that is installed. Read-only, local
// files written by the project: not outside content, nothing to approve.
//
// Three actions, sized so an agent never has to take the whole manual (150 KB) to answer one
// question: `index` (pages and their sections), `search` (the sections that match some words)
// and `read` (one page, or one section of a long one).

const LANGS = ["en", "es"] as const;
type Lang = (typeof LANGS)[number];
/** What one `read` returns at most; a longer page is read by section. */
const MAX_READ_CHARS = 12_000;
const MAX_HITS = 6;
const EXCERPT_CHARS = 260;

interface Page { slug: string; file: string; title: Record<string, string> }
interface Section { level: number; heading: string; /** "Gmail › 3. Who may use which account" */ trail: string; start: number; end: number; bodyEnd: number }

const dirOf = () => process.env.HYDRA_DOCS_DIR || docsDir;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function loadPages(): Promise<Page[]> {
  const raw = JSON.parse(await readFile(path.join(dirOf(), "manifest.json"), "utf-8"));
  return (Array.isArray(raw?.pages) ? raw.pages : []).filter((p: any) => typeof p?.slug === "string" && /^[\w.-]+\.md$/.test(String(p?.file)));
}

/** The page's text as an agent needs it: no images (it cannot see them from here). */
async function loadText(lang: Lang, page: Page): Promise<string | null> {
  for (const l of [lang, "en"] as const) {
    try {
      const md = await readFile(path.join(dirOf(), l, page.file), "utf-8");
      return md.replace(/\r\n/g, "\n").replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    } catch { /* that language is missing: fall back to English */ }
  }
  return null;
}

/** Headings outside code fences. `end` closes the heading's own text, `bodyEnd` includes its sub-sections. */
function sectionsOf(md: string): Section[] {
  const out: Section[] = [];
  const stack: Section[] = [];
  let fence = false, pos = 0;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (m) {
      const level = m[1].length;
      if (out.length) out[out.length - 1].end = pos;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()!.bodyEnd = pos;
      const s: Section = { level, heading: m[2].trim(), trail: [...stack.filter((x) => x.level > 1).map((x) => x.heading), m[2].trim()].join(" › "), start: pos, end: md.length, bodyEnd: md.length };
      out.push(s); stack.push(s);
    }
    pos += line.length + 1;
  }
  return out;
}

const titleOf = (p: Page, lang: Lang) => p.title?.[lang] || p.title?.en || p.slug;

function findPage(pages: Page[], want: string): Page | undefined {
  const w = norm(want).trim().replace(/^\.\//, "").replace(/\.md$/, "");
  if (!w) return undefined;
  return pages.find((p) => p.slug === w)
    ?? pages.find((p) => p.file.replace(/\.md$/, "") === w)
    ?? pages.find((p) => /^\d+$/.test(w) && Number(p.file.slice(0, 2)) === Number(w))
    ?? pages.find((p) => LANGS.some((l) => norm(p.title?.[l] ?? "") === w));
}

async function index(lang: Lang): Promise<string> {
  const pages = await loadPages();
  const lines: string[] = [];
  for (const p of pages) {
    const md = await loadText(lang, p);
    if (md === null) continue;
    const parts = sectionsOf(md).filter((s) => s.level === 2).map((s) => s.heading);
    lines.push(`- ${p.slug} — ${titleOf(p, lang)} (${md.length} chars)${parts.length ? `: ${parts.join(" · ")}` : ""}`);
  }
  if (!lines.length) return "The manual is not installed with this copy of HydraOps.";
  return `HydraOps manual, ${lines.length} pages (page — title: its sections). Read one with action "read" and its page name; a page over ${MAX_READ_CHARS} chars is read by section.\n${lines.join("\n")}`;
}

// Words that match almost every section and say nothing about what is asked.
const STOP = new Set("a an and are as at be by can do does for from how i in is it my of on or that the this to what when where which with you your al como con cual cuando de del donde el en es la las lo los me mi para por que se si su un una y".split(" "));

interface Hit { score: number; lang: Lang; page: Page; s: Section; excerpt: string }

/** The stretch of the section where most of the words asked for come together. */
function excerptOf(text: string, words: string[]): string {
  const body = norm(text);
  const at: { pos: number; w: string }[] = [];
  for (const w of words) for (let i = body.indexOf(w); i >= 0 && at.length < 400; i = body.indexOf(w, i + w.length)) at.push({ pos: i, w });
  let from = 0, best = -1;
  for (const m of at) {
    const start = Math.max(0, m.pos - 50);
    const seen = new Set(at.filter((x) => x.pos >= start && x.pos < start + EXCERPT_CHARS).map((x) => x.w)).size;
    if (seen > best) { best = seen; from = start; }
  }
  const cut = text.slice(from, from + EXCERPT_CHARS).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + cut + (from + EXCERPT_CHARS < text.length ? "…" : "");
}

async function searchIn(lang: Lang, words: string[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const page of await loadPages()) {
    const md = await loadText(lang, page);
    if (md === null) continue;
    const title = norm(titleOf(page, lang));
    for (const s of sectionsOf(md)) {
      const text = md.slice(s.start, s.end);
      const body = norm(text), head = norm(s.trail);
      let matched = 0, score = 0;
      for (const w of words) {
        const inBody = Math.min(body.split(w).length - 1, 5);
        const inHead = head.includes(w) ? 4 : 0;
        const inTitle = title.includes(w) ? 1 : 0;
        if (inBody || inHead) matched++;
        score += inBody + inHead + inTitle;
      }
      if (matched) hits.push({ score: matched * 100 + score, lang, page, s, excerpt: excerptOf(text, words) });
    }
  }
  return hits.sort((x, y) => y.score - x.score);
}

/** With no language given, the manual is searched in both and the one the words belong to answers. */
async function search(lang: Lang | undefined, query: string): Promise<string> {
  const all = [...new Set(norm(query).split(/[^a-z0-9_]+/).filter((w) => w.length >= 2))];
  const words = all.some((w) => !STOP.has(w)) ? all.filter((w) => !STOP.has(w)) : all;
  if (!words.length) return "Nothing to search: give a few words.";
  let hits: Hit[] = [];
  for (const l of lang ? [lang] : LANGS) {
    const h = await searchIn(l, words);
    if (h.length && (!hits.length || h[0].score > hits[0].score)) hits = h;
  }
  if (!hits.length) return `Nothing in the manual matches "${query}". Try other words, or action "index" to see what it covers.`;
  const top = hits.slice(0, MAX_HITS);
  return `${hits.length} section(s) of the manual (${hits[0].lang}) match "${query}"; the best ${top.length}, best first. Read one with action "read", its page, its section and lang "${hits[0].lang}".\n\n`
    + top.map((h) => `page: ${h.page.slug} · section: ${h.s.level === 1 ? "(top of the page)" : h.s.heading}\n${h.s.trail}\n${h.excerpt}`).join("\n\n");
}

async function read(lang: Lang, want: string, section?: string): Promise<string> {
  const pages = await loadPages();
  const page = findPage(pages, want);
  if (!page) return `No page "${want}" in the manual. Pages: ${pages.map((p) => p.slug).join(", ")}.`;
  const md = await loadText(lang, page);
  if (md === null) return `The page "${page.slug}" is not installed with this copy of HydraOps.`;
  const secs = sectionsOf(md);
  const outline = (within?: Section) => secs
    .filter((s) => s.level > 1 && (!within || (s.start > within.start && s.start < within.bodyEnd)))
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 2))}- ${s.heading} (${s.bodyEnd - s.start} chars)`).join("\n");

  if (section?.trim()) {
    const w = norm(section).trim();
    const found = secs.find((s) => norm(s.heading) === w) ?? secs.find((s) => norm(s.heading).includes(w)) ?? secs.find((s) => norm(s.trail).includes(w));
    if (!found) return `No section "${section}" in the page "${page.slug}". Its sections:\n${outline()}`;
    const text = md.slice(found.start, found.bodyEnd).trim();
    if (text.length <= MAX_READ_CHARS) return `[HydraOps manual · ${page.slug} · ${found.trail}]\n\n${text}`;
    return `[HydraOps manual · ${page.slug} · ${found.trail}] — ${text.length} chars, too long to give whole: its first part follows; read the rest by its sub-sections:\n${outline(found)}\n\n${md.slice(found.start, Math.min(found.end, found.start + MAX_READ_CHARS)).trim()}`;
  }
  if (md.length <= MAX_READ_CHARS) return `[HydraOps manual · ${page.slug} · ${titleOf(page, lang)}]\n\n${md}`;
  const firstH2 = secs.find((s) => s.level === 2);
  const intro = md.slice(0, firstH2 ? firstH2.start : MAX_READ_CHARS).trim().slice(0, MAX_READ_CHARS);
  return `[HydraOps manual · ${page.slug} · ${titleOf(page, lang)}] — ${md.length} chars, too long to give whole. Its opening follows; read what you need with "section" (a heading from this list):\n${outline()}\n\n${intro}`;
}

export const hydraopsDocsTool: HydraTool = {
  name: "hydraops_docs",
  title: "HydraOps manual",
  // Local files that ship with the app: nothing leaves, nothing changes, nothing from outside comes in.
  risk: {},
  vault: false,
  description:
    "Read the manual of HydraOps, the application you run in: how its agents, chat, tools, connections, scheduled tasks, skills, security and server mode work, and how the user sets each one up. Use it when the user asks how to do something in HydraOps or why it behaves a certain way, instead of answering from memory. Actions: \"index\" lists the pages and their sections; \"search\" finds the sections that match a few words; \"read\" gives one page, or one section of a long page. The manual describes the installed version and exists in English and Spanish.",
  schema: z.object({
    action: z.enum(["index", "search", "read"]).describe("index: the pages and their sections · search: sections matching `query` · read: the page `page`, or its `section`"),
    query: z.string().optional().describe("search: a few words about what you need, in English or Spanish"),
    page: z.string().optional().describe("read: a page name from the index (e.g. \"tools\")"),
    section: z.string().optional().describe("read: a heading of that page, to get only that section"),
    lang: z.enum(LANGS).optional().describe("Language of the manual: \"en\" (default) or \"es\". A search with no lang looks in both and says which one answered"),
  }),
  execute: async ({ action, query, page, section, lang }) => {
    const l: Lang = lang === "es" ? "es" : "en";
    try {
      if (action === "index") return await index(l);
      if (action === "search") return await search(lang === "es" || lang === "en" ? lang : undefined, String(query ?? ""));
      if (!String(page ?? "").trim()) return "read needs `page`: a page name from the index.";
      return await read(l, String(page), section);
    } catch (e: any) {
      if (e?.code === "ENOENT") return "The manual is not installed with this copy of HydraOps.";
      return `Could not read the manual: ${e?.message || e}`;
    }
  },
};

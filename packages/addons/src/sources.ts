/**
 * Sources of an answer: the URLs the agent's tools actually opened or were shown
 * while it worked. They are stored with the task result, listed under the reply
 * and fed back into the conversation history — so a later "give me the link" is
 * answered with a real address instead of a plausible-looking guess.
 */
export interface ToolSource {
  url: string;
  title?: string;
  /** read = the agent opened this page; found = it appeared in search results. */
  kind: 'read' | 'found';
  /** Tool that produced it (fetch_url, web_search, …). */
  via: string;
}

/** `seen`: every address that appeared anywhere in the tool's result (links inside a page
 *  it read, for instance) — not listed as sources, but the model did see them. */
export type ToolSourceSink = (sources: ToolSource[], seen?: string[]) => void;

const MAX_PER_CALL = 12;
export const MAX_SOURCES_READ = 10;
export const MAX_SOURCES_FOUND = 15;
const MAX_SEEN_PER_CALL = 200;
export const MAX_SEEN = 300;

// Tools whose plain-text output is worth scanning for URLs.
const SCANNABLE = /search|perplexity|browse|crawl|scrape/i;

function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  while (s && '.,;:!?)]}>"\''.includes(s[s.length - 1])) s = s.slice(0, -1);
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    // Never list the app's own plumbing (key-proxy, local API, local models).
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// One negated character class, no nesting: linear on any input.
const URL_SCAN = /https?:\/\/[^\s<>"'`)\]}]+/g;

/** What a tool call contributes: from its arguments, its structured output, or its text. */
export function extractSources(toolName: string, args: any, result: unknown): ToolSource[] {
  const out: ToolSource[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, kind: ToolSource['kind'], title?: unknown) => {
    const clean = cleanUrl(url);
    if (!clean || seen.has(clean) || out.length >= MAX_PER_CALL) return;
    seen.add(clean);
    const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    out.push({ url: clean, kind, via: toolName, ...(t ? { title: t } : {}) });
  };

  const text = typeof result === 'string' ? result : '';
  const failed = /^(⛔|error\b|failed\b|could not\b|fetch error\b|search error\b)/i.test(text.trim());

  // The page the agent asked to open (fetch_url, youtube_transcript, browser-like MCP tools).
  if (!failed) {
    for (const key of ['url', 'videoUrl', 'video_url', 'link']) add(args?.[key], 'read');
  }
  if (failed || !text) return out;

  // Search tools return a JSON list of { title, link|url, snippet }.
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
      for (const item of list) add(item?.link ?? item?.url, 'found', item?.title);
      if (out.length) return out;
    } catch { /* not JSON after all: fall through to the text scan */ }
  }

  if (SCANNABLE.test(toolName)) {
    for (const m of text.slice(0, 40_000).matchAll(URL_SCAN)) add(m[0], 'found');
  }
  return out;
}

/** Every address in a tool result, cleaned the same way as sources. */
export function extractSeenUrls(result: unknown): string[] {
  let text = '';
  if (typeof result === 'string') text = result;
  else { try { text = JSON.stringify(result) ?? ''; } catch { text = ''; } }
  const out = new Set<string>();
  for (const m of text.slice(0, 60_000).matchAll(URL_SCAN)) {
    const clean = cleanUrl(m[0]);
    if (clean) out.add(clean);
    if (out.size >= MAX_SEEN_PER_CALL) break;
  }
  return [...out];
}

/** Collects the sources of one task: deduplicated, capped, "read" wins over "found". */
export function createSourceCollector() {
  const byUrl = new Map<string, ToolSource>();
  const seenUrls = new Set<string>();
  const addSeen = (url: string) => { if (seenUrls.size < MAX_SEEN) seenUrls.add(url); };
  return {
    sink: ((sources: ToolSource[], seen?: string[]) => {
      for (const s of sources) addSeen(s.url);
      for (const u of seen ?? []) addSeen(u);
      for (const s of sources) {
        const prev = byUrl.get(s.url);
        if (!prev) byUrl.set(s.url, s);
        else if (prev.kind === 'found' && s.kind === 'read') byUrl.set(s.url, { ...s, title: s.title ?? prev.title });
        else if (!prev.title && s.title) byUrl.set(s.url, { ...prev, title: s.title });
      }
    }) as ToolSourceSink,
    /** Everything the task's tools opened, found or showed: the chat checks reply links against it. */
    seen(): string[] {
      return [...seenUrls];
    },
    list(): ToolSource[] {
      const all = [...byUrl.values()];
      return [
        ...all.filter((s) => s.kind === 'read').slice(0, MAX_SOURCES_READ),
        ...all.filter((s) => s.kind === 'found').slice(0, MAX_SOURCES_FOUND),
      ];
    },
  };
}

/**
 * The assistant turn as the model sees it in the history: its text plus the real
 * addresses behind it. Without this a follow-up question about "the link" has
 * nothing to draw on but the model's imagination.
 */
export function historyAssistantText(resultMeta: any): string {
  const text = String(resultMeta?.text || resultMeta?.preview || resultMeta?.raw || '');
  const sources: ToolSource[] = Array.isArray(resultMeta?.sources) ? resultMeta.sources : [];
  if (!text || !sources.length) return text;
  const lines = sources.slice(0, 12).map((s) => `- ${s.title ? `${s.title} — ` : ''}${s.url}${s.kind === 'read' ? ' (opened)' : ''}`);
  return `${text}\n\n[Sources consulted for this answer — real URLs, quote them verbatim when asked for a link]\n${lines.join('\n')}`;
}

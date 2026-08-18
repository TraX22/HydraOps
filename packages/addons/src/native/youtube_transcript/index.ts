import { z } from "zod";
import { HydraTool } from "../../../types.js";

// youtube_transcript — fetch a YouTube video's transcript (captions/subtitles).
//
// It reads the caption tracks a video already exposes (uploaded subtitles or
// YouTube's auto-generated ones) — it does NOT run speech-to-text on the audio,
// which would need downloading the media plus a Whisper-class model. No API key
// is required. The transcript is capped so a long video can't flood a local
// model's context (the MCP-cap lesson).
//
// It talks to YouTube's InnerTube "player" endpoint with the IOS client. The
// caption baseUrl from the normal watch page now returns an empty body unless a
// "pot" (proof-of-origin) token is attached; the IOS client's caption URLs
// still serve the transcript directly, which is why yt-dlp uses it too.

const INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w"; // public InnerTube key
const IOS_UA = "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X)";
const IOS_CLIENT = { clientName: "IOS", clientVersion: "20.03.02", deviceModel: "iPhone16,2", hl: "en", gl: "US" };

const MAX_OUTPUT = 15000;

// Accepts a full YouTube URL (watch, youtu.be, shorts, embed, live) or a bare
// 11-character video id.
function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1, 12);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL — fall through */ }
  const m = s.match(/(?:v=|\/)([A-Za-z0-9_-]{11})(?:[?&/]|$)/);
  return m ? m[1] : null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// InnerTube player response (IOS client) for a video id.
async function iosPlayer(videoId: string): Promise<any> {
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": IOS_UA,
      "X-Goog-Api-Format-Version": "2",
    },
    body: JSON.stringify({ videoId, context: { client: IOS_CLIENT } }),
  });
  if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
  return res.json();
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string; // "asr" for auto-generated
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// The caption endpoint returns XML: <text start="…" dur="…">line</text>.
function parseTranscriptXml(xml: string): string {
  const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

async function getTranscript(input: string, lang?: string): Promise<string> {
  const id = extractVideoId(input);
  if (!id) {
    return "youtube_transcript: couldn't recognise a YouTube video in that input. Pass a full video URL or the 11-character video id.";
  }
  console.log(`[Tool: YouTubeTranscript] Fetching transcript for ${id}${lang ? ` (lang=${lang})` : ""}`);

  let player: any;
  try {
    player = await iosPlayer(id);
  } catch (e: any) {
    return `youtube_transcript: error loading the video data: ${e.message}`;
  }

  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = player.playabilityStatus?.reason || status;
    return `youtube_transcript: this video is not available (${reason}).`;
  }

  const title: string = player.videoDetails?.title || "";
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const tracks: CaptionTrack[] = renderer?.captionTracks || [];
  if (tracks.length === 0) {
    return `youtube_transcript: "${title || id}" has no transcript/captions available.`;
  }

  // The video's own default caption track (the original language) — otherwise a
  // heavily-translated video (e.g. a TED talk) would default to whatever track
  // comes first alphabetically instead of what was actually spoken.
  const audioTracks = renderer?.audioTracks || [];
  const defCapIdx = audioTracks[renderer?.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex;
  const defaultTrack = typeof defCapIdx === "number" ? tracks[defCapIdx] : undefined;

  const wanted = (lang || "").toLowerCase();
  const track =
    (wanted && tracks.find((t) => t.languageCode?.toLowerCase() === wanted && t.kind !== "asr")) ||
    (wanted && tracks.find((t) => t.languageCode?.toLowerCase().startsWith(wanted))) ||
    defaultTrack ||                        // the video's original/default track
    tracks.find((t) => t.kind !== "asr") || // else prefer a human-made track over auto
    tracks[0];

  const availableLangs = [...new Set(tracks.map((t) => t.languageCode).filter(Boolean))].join(", ");

  let xml: string;
  try {
    // baseUrl comes from YouTube's own player response; only fetch YouTube hosts.
    const capHost = new URL(track.baseUrl).hostname;
    if (!(capHost === "youtube.com" || capHost.endsWith(".youtube.com"))) {
      return "youtube_transcript: the caption URL was not a YouTube host; refusing to fetch it.";
    }
    const capRes = await fetchWithTimeout(track.baseUrl, { headers: { "User-Agent": IOS_UA } });
    if (!capRes.ok) return `youtube_transcript: could not download the captions (HTTP ${capRes.status}).`;
    xml = await capRes.text();
  } catch (e: any) {
    return `youtube_transcript: error downloading the captions: ${e.message}`;
  }

  const text = parseTranscriptXml(xml);
  if (!text) {
    return `youtube_transcript: the caption track for "${title || id}" came back empty.`;
  }

  const auto = track.kind === "asr" ? ", auto-generated" : "";
  const header =
    `Transcript — ${title || id}\n` +
    `(language: ${track.languageCode || "?"}${auto}; available: ${availableLangs})\n\n`;

  let out = header + text;
  if (out.length > MAX_OUTPUT) {
    const omitted = out.length - MAX_OUTPUT;
    out = out.slice(0, MAX_OUTPUT) +
      `\n\n[transcript truncated: ${omitted} more characters. Ask for a summary, or a specific part of the video.]`;
  }
  return out;
}

export const youtubeTranscriptTool: HydraTool = {
  name: "youtube_transcript",
  description:
    "Fetch the transcript (captions/subtitles) of a YouTube video from its URL or id — uploaded subtitles or YouTube's auto-generated ones. Use it to summarise, quote, or answer questions about a video. Optionally pass a 2-letter language code to pick a caption track.",
  schema: z.object({
    url: z.string().describe("YouTube video URL or the 11-character video id"),
    lang: z
      .string()
      .length(2)
      .optional()
      .describe("Optional 2-letter language code for the caption track (e.g. 'en', 'es'). Defaults to the video's own captions."),
  }),
  execute: async ({ url, lang }) => await getTranscript(url, lang),
};

/**
 * latest-release.ts — which HydraOps release is the latest, asked of GitHub.
 *
 * GitHub's API allows 60 unauthenticated requests an hour per public IP, and two
 * HydraOps on the same connection (a desktop and a bench, or a user who presses "check
 * now" a few times) run through that: the API then answers 403, which used to look like
 * "no connection" and was cached for six hours. So the tag is resolved first without the
 * API: `github.com/<repo>/releases/latest` redirects to `/releases/tag/<tag>`, a plain
 * page with no such limit; the API is the second road. A failure says what it was (the
 * network, GitHub's limit, no release at all), so the sidebar and the update button can
 * tell the user, and the caller caches it briefly, not for hours.
 */

export const RELEASES_PAGE = "https://github.com/TraX22/HydraOps/releases/latest";
export const RELEASES_API = "https://api.github.com/repos/TraX22/HydraOps/releases/latest";
const TIMEOUT_MS = 5000;

export interface LatestRelease { tag: string; latest: string; url: string }
/** offline: nothing answered; rate_limited: GitHub refused the API call (403/429); no_release: GitHub answered but named no release. */
export type LatestFailure = "offline" | "rate_limited" | "no_release";
export type LatestResult = { ok: true; release: LatestRelease } | { ok: false; reason: LatestFailure; status?: number };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The release a redirect to `/releases/tag/<tag>` names, or null when the address is something else. */
export function parseLatestLocation(location: string | null | undefined): LatestRelease | null {
  if (!location) return null;
  const m = /\/releases\/tag\/(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\/?(?:[?#].*)?$/.exec(String(location).trim());
  if (!m) return null;
  const tag = decodeURIComponent(m[1]);
  return { tag, latest: tag.replace(/^v/, ""), url: `https://github.com/TraX22/HydraOps/releases/tag/${encodeURIComponent(tag)}` };
}

/** The latest release: by the redirect of the releases page first, then by the API; or why neither said. */
export async function resolveLatestRelease(fetchImpl: FetchLike = fetch): Promise<LatestResult> {
  let threw = 0;
  // 1. The page: GitHub answers the HEAD with a redirect to the tag's page.
  try {
    const r = await fetchImpl(RELEASES_PAGE, { method: "HEAD", redirect: "manual", headers: { "User-Agent": "HydraOps" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400) {
      const release = parseLatestLocation(r.headers.get("location"));
      if (release) return { ok: true, release };
    }
  } catch { threw++; }
  // 2. The API: the full answer, under its hourly limit.
  try {
    const r = await fetchImpl(RELEASES_API, { headers: { "User-Agent": "HydraOps", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 403 || r.status === 429) return { ok: false, reason: "rate_limited", status: r.status };
    if (r.ok) {
      const j: any = await r.json().catch(() => null);
      const tag = j && typeof j.tag_name === "string" ? j.tag_name : "";
      if (/^v?\d+\.\d+\.\d+/.test(tag)) return { ok: true, release: { tag, latest: tag.replace(/^v/, ""), url: typeof j.html_url === "string" ? j.html_url : `https://github.com/TraX22/HydraOps/releases/tag/${encodeURIComponent(tag)}` } };
    }
    return { ok: false, reason: "no_release", status: r.status };
  } catch { threw++; }
  return { ok: false, reason: threw === 2 ? "offline" : "no_release" };
}

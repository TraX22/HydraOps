/**
 * x-ops.ts — what HydraOps may do on X, as one closed table.
 *
 * Every call the tools make to X goes through `callOp` in x.ts, which only knows the
 * operations listed here: method, path, the permission group it needs, the scopes X must
 * have granted the account, and X's list price. Nothing outside this table reaches X, and
 * the same table tells the API what to charge against the account's cap and the task's
 * budget, and tells the card what a permission group allows.
 *
 * Permission groups ("grants") are what the user picks when connecting an account; each
 * maps to the OAuth scopes X asks the account to accept. Reading needs nothing beyond the
 * base scopes (profile, posts, session), so `read` carries no scope of its own and is
 * decided on this side only.
 *
 * Prices are X's published pay-per-use list (docs.x.com, "Pricing"), in USD, charged per
 * resource returned or per request. They are estimates: X's own portal is the reference.
 */

export type XGrant = "read" | "publish" | "engage" | "messages";
export const GRANTS: XGrant[] = ["read", "publish", "engage", "messages"];
export const isGrant = (v: unknown): v is XGrant => typeof v === "string" && (GRANTS as string[]).includes(v);

/** Scopes every connection asks for: who the account is, read posts, keep the session. */
export const BASE_SCOPES = ["tweet.read", "users.read", "offline.access"];
export const GRANT_SCOPES: Record<XGrant, string[]> = {
  read: [],
  publish: ["tweet.write", "media.write"],
  engage: ["like.read", "like.write", "bookmark.read", "bookmark.write", "follows.read", "follows.write", "block.read", "block.write", "mute.read", "mute.write", "tweet.moderate.write"],
  // X only grants these when the app itself has the "Direct message" permission level.
  messages: ["dm.read", "dm.write"],
};

/** The scopes to ask X for, for a set of grants (base ones always included). */
export function scopesFor(grants: XGrant[]): string[] {
  const out = new Set(BASE_SCOPES);
  for (const g of grants) for (const s of GRANT_SCOPES[g] ?? []) out.add(s);
  return [...out];
}
/** The grants a set of granted scopes fully covers. */
export function grantsCoveredBy(scopes: string[]): XGrant[] {
  const have = new Set(scopes);
  return GRANTS.filter((g) => GRANT_SCOPES[g].every((s) => have.has(s)));
}
/** The scopes a set of grants needs that the account does not have. */
export function missingScopes(grants: XGrant[], scopes: string[]): string[] {
  const have = new Set(scopes);
  return scopesFor(grants).filter((s) => !have.has(s));
}

export interface XOp {
  name: string;
  method: "GET";
  /** The path, with `:me` (the account's own id), `:id` (a post or user id) or `:username`. */
  path: string;
  /** The permission group the account must have been connected with. */
  grant: XGrant;
  /** Scopes beyond the base ones this call needs (X refuses it without them). */
  scopes?: string[];
  /** X's list price, and whether it is per resource returned or per request. */
  usd: number;
  unit: "resource" | "request";
  /** The query parameters the caller may set; anything else is dropped. */
  query: string[];
  /** The smallest and largest `max_results` X takes here. */
  results?: [number, number];
  /** Query parameters fixed here: which fields come back. */
  fixed: Record<string, string>;
}

// The fields every post comes with: enough to show it, say who wrote it and how it did.
const POST_FIELDS = "id,text,created_at,author_id,conversation_id,in_reply_to_user_id,public_metrics,entities,referenced_tweets,attachments,lang,note_tweet";
const POST_QUERY = { "tweet.fields": POST_FIELDS, expansions: "author_id", "user.fields": "username,name" };
const USER_FIELDS = { "user.fields": "id,username,name,description,created_at,location,url,verified,verified_type,public_metrics,profile_image_url,protected" };
const PAGE = ["max_results", "pagination_token", "since_id", "until_id"];
const SEARCH = ["query", "max_results", "next_token", "since_id", "until_id", "start_time", "end_time", "sort_order"];
const COUNTS = ["query", "granularity", "start_time", "end_time", "since_id", "until_id", "next_token"];

const OPS: XOp[] = [
  // Users
  { name: "user", method: "GET", path: "/2/users/by/username/:username", grant: "read", usd: 0.010, unit: "resource", query: [], fixed: USER_FIELDS },
  { name: "user_by_id", method: "GET", path: "/2/users/:id", grant: "read", usd: 0.010, unit: "resource", query: [], fixed: USER_FIELDS },
  // The account's own reads (X's "owned reads" price)
  { name: "my_posts", method: "GET", path: "/2/users/:me/tweets", grant: "read", usd: 0.001, unit: "resource", query: [...PAGE, "exclude"], results: [5, 100], fixed: POST_QUERY },
  { name: "mentions", method: "GET", path: "/2/users/:me/mentions", grant: "read", usd: 0.001, unit: "resource", query: PAGE, results: [5, 100], fixed: POST_QUERY },
  { name: "liked", method: "GET", path: "/2/users/:me/liked_tweets", grant: "engage", scopes: ["like.read"], usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [5, 100], fixed: POST_QUERY },
  { name: "bookmarks", method: "GET", path: "/2/users/:me/bookmarks", grant: "engage", scopes: ["bookmark.read"], usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: POST_QUERY },
  // The account's own post with the metrics only its author sees.
  { name: "post_metrics", method: "GET", path: "/2/tweets/:id", grant: "read", usd: 0.001, unit: "resource", query: [], fixed: { ...POST_QUERY, "tweet.fields": `${POST_FIELDS},non_public_metrics,organic_metrics` } },
  // Other people's posts
  { name: "home", method: "GET", path: "/2/users/:me/timelines/reverse_chronological", grant: "read", usd: 0.005, unit: "resource", query: [...PAGE, "exclude"], results: [1, 100], fixed: POST_QUERY },
  { name: "user_posts", method: "GET", path: "/2/users/:id/tweets", grant: "read", usd: 0.005, unit: "resource", query: [...PAGE, "exclude"], results: [5, 100], fixed: POST_QUERY },
  { name: "post", method: "GET", path: "/2/tweets/:id", grant: "read", usd: 0.005, unit: "resource", query: [], fixed: POST_QUERY },
  { name: "quotes", method: "GET", path: "/2/tweets/:id/quote_tweets", grant: "read", usd: 0.005, unit: "resource", query: ["max_results", "pagination_token", "exclude"], results: [10, 100], fixed: POST_QUERY },
  { name: "likers", method: "GET", path: "/2/tweets/:id/liking_users", grant: "read", usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: USER_FIELDS },
  { name: "reposters", method: "GET", path: "/2/tweets/:id/retweeted_by", grant: "read", usd: 0.010, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: USER_FIELDS },
  // Search
  { name: "search_recent", method: "GET", path: "/2/tweets/search/recent", grant: "read", usd: 0.005, unit: "resource", query: SEARCH, results: [10, 100], fixed: POST_QUERY },
  { name: "search_all", method: "GET", path: "/2/tweets/search/all", grant: "read", usd: 0.005, unit: "resource", query: SEARCH, results: [10, 100], fixed: POST_QUERY },
  { name: "counts_recent", method: "GET", path: "/2/tweets/counts/recent", grant: "read", usd: 0.005, unit: "request", query: COUNTS, fixed: {} },
  { name: "counts_all", method: "GET", path: "/2/tweets/counts/all", grant: "read", usd: 0.010, unit: "request", query: COUNTS, fixed: {} },
];
const BY_NAME = new Map(OPS.map((o) => [o.name, o]));

export const opNamed = (name: unknown): XOp | undefined => (typeof name === "string" ? BY_NAME.get(name) : undefined);
export const opNames = (): string[] => OPS.map((o) => o.name);

/** The estimated charge of one answer: resources returned (data items) or one request. */
export function estimateUsd(op: XOp, body: any): { resources: number; usd: number } {
  const resources = op.unit === "request" ? 1 : Array.isArray(body?.data) ? body.data.length : body?.data ? 1 : 0;
  return { resources, usd: Number((resources * op.usd).toFixed(4)) };
}

/** The table without its internals, for the API (what each operation is for and costs). */
export const opsPublic = (): { name: string; grant: XGrant; scopes: string[]; usd: number; unit: XOp["unit"]; results?: [number, number] }[] =>
  OPS.map((o) => ({ name: o.name, grant: o.grant, scopes: o.scopes ?? [], usd: o.usd, unit: o.unit, ...(o.results ? { results: o.results } : {}) }));

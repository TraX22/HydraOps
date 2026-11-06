/**
 * x-ops.ts — what HydraOps may do on X, as one closed table.
 *
 * Every call the tools make to X (except publishing, see postThread) goes through `callOp`
 * in x.ts, which only knows the operations listed here: method, path, whether it reads or
 * writes, the permission group it needs, the scopes X must have granted the account, and
 * X's list price. Nothing outside this table reaches X, and
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
  engage: ["like.read", "like.write", "bookmark.read", "bookmark.write", "follows.read", "follows.write", "block.read", "block.write", "mute.read", "mute.write", "tweet.moderate.write", "list.write"],
  // X only grants these when the app itself has the "Direct message" permission level.
  messages: ["dm.read", "dm.write"],
};
/**
 * Asked for at every sign-in with the base scopes, but not required: lists and Spaces are
 * reads, so they belong to "read", yet an account connected before they existed must not
 * lose its grants for lacking them. Such an account is told to connect again (missingScopes).
 */
export const OPTIONAL_SCOPES = ["list.read", "space.read"];

/** The scopes to ask X for, for a set of grants (base ones always included). */
export function scopesFor(grants: XGrant[], withOptional = false): string[] {
  const out = new Set(BASE_SCOPES);
  for (const g of grants) for (const s of GRANT_SCOPES[g] ?? []) out.add(s);
  if (withOptional) for (const s of OPTIONAL_SCOPES) out.add(s);
  return [...out];
}
/** The grants a set of granted scopes fully covers. */
export function grantsCoveredBy(scopes: string[]): XGrant[] {
  const have = new Set(scopes);
  return GRANTS.filter((g) => GRANT_SCOPES[g].every((s) => have.has(s)));
}
/** The scopes a set of grants needs that the account does not have. */
export function missingScopes(grants: XGrant[], scopes: string[], withOptional = false): string[] {
  const have = new Set(scopes);
  return scopesFor(grants, withOptional).filter((s) => !have.has(s));
}

export interface XOp {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** A read changes nothing on X and is not held; a write is held for the user's approval. */
  kind: "read" | "write";
  /** The path, with `:me` (the account's own id), `:id` (a post, user, list, Space or community id), `:username`, `:conversation` (a DM conversation id), `:list` (a list id) or `:user` (a second user id). */
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
  /** For a write: the JSON body, as caller parameter → X's field name (ids checked; `hidden` and `private` booleans; `text`, `name` and `description` strings). */
  body?: Record<string, string>;
}

// The fields every post comes with: enough to show it, say who wrote it and how it did.
const POST_FIELDS = "id,text,created_at,author_id,conversation_id,in_reply_to_user_id,public_metrics,entities,referenced_tweets,attachments,lang,note_tweet";
const POST_QUERY = { "tweet.fields": POST_FIELDS, expansions: "author_id", "user.fields": "username,name" };
const USER_FIELDS = { "user.fields": "id,username,name,description,created_at,location,url,verified,verified_type,public_metrics,profile_image_url,protected" };
const PAGE = ["max_results", "pagination_token", "since_id", "until_id"];
const SEARCH = ["query", "max_results", "next_token", "since_id", "until_id", "start_time", "end_time", "sort_order"];
const COUNTS = ["query", "granularity", "start_time", "end_time", "since_id", "until_id", "next_token"];

const USER_PAGE = ["max_results", "pagination_token"];
const LIST_FIELDS = { "list.fields": "id,name,description,private,follower_count,member_count,owner_id,created_at", expansions: "owner_id", "user.fields": "username,name" };
const SPACE_QUERY = { "space.fields": "id,title,state,created_at,started_at,scheduled_start,ended_at,host_ids,creator_id,participant_count,subscriber_count,lang,is_ticketed,topic_ids", expansions: "creator_id,host_ids", "user.fields": "username,name" };
const COMMUNITY_FIELDS = { "community.fields": "id,name,description,access,join_policy,member_count,created_at" };
// A message event: who sent it, in which conversation, when, the text, what it attaches or references.
const DM_QUERY = { "dm_event.fields": "id,text,event_type,created_at,sender_id,dm_conversation_id,attachments,referenced_tweets,participant_ids", expansions: "sender_id,participant_ids", "user.fields": "username,name" };
const OPS: XOp[] = [
  // Users
  { name: "user", method: "GET", kind: "read", path: "/2/users/by/username/:username", grant: "read", usd: 0.010, unit: "resource", query: [], fixed: USER_FIELDS },
  { name: "user_by_id", method: "GET", kind: "read", path: "/2/users/:id", grant: "read", usd: 0.010, unit: "resource", query: [], fixed: USER_FIELDS },
  // The account's own reads (X's "owned reads" price)
  { name: "my_posts", method: "GET", kind: "read", path: "/2/users/:me/tweets", grant: "read", usd: 0.001, unit: "resource", query: [...PAGE, "exclude"], results: [5, 100], fixed: POST_QUERY },
  { name: "mentions", method: "GET", kind: "read", path: "/2/users/:me/mentions", grant: "read", usd: 0.001, unit: "resource", query: PAGE, results: [5, 100], fixed: POST_QUERY },
  { name: "liked", method: "GET", kind: "read", path: "/2/users/:me/liked_tweets", grant: "engage", scopes: ["like.read"], usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [5, 100], fixed: POST_QUERY },
  { name: "bookmarks", method: "GET", kind: "read", path: "/2/users/:me/bookmarks", grant: "engage", scopes: ["bookmark.read"], usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: POST_QUERY },
  // The account's own post with the metrics only its author sees.
  { name: "post_metrics", method: "GET", kind: "read", path: "/2/tweets/:id", grant: "read", usd: 0.001, unit: "resource", query: [], fixed: { ...POST_QUERY, "tweet.fields": `${POST_FIELDS},non_public_metrics,organic_metrics` } },
  // Other people's posts
  { name: "home", method: "GET", kind: "read", path: "/2/users/:me/timelines/reverse_chronological", grant: "read", usd: 0.005, unit: "resource", query: [...PAGE, "exclude"], results: [1, 100], fixed: POST_QUERY },
  { name: "user_posts", method: "GET", kind: "read", path: "/2/users/:id/tweets", grant: "read", usd: 0.005, unit: "resource", query: [...PAGE, "exclude"], results: [5, 100], fixed: POST_QUERY },
  { name: "post", method: "GET", kind: "read", path: "/2/tweets/:id", grant: "read", usd: 0.005, unit: "resource", query: [], fixed: POST_QUERY },
  { name: "quotes", method: "GET", kind: "read", path: "/2/tweets/:id/quote_tweets", grant: "read", usd: 0.005, unit: "resource", query: ["max_results", "pagination_token", "exclude"], results: [10, 100], fixed: POST_QUERY },
  { name: "likers", method: "GET", kind: "read", path: "/2/tweets/:id/liking_users", grant: "read", usd: 0.001, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: USER_FIELDS },
  { name: "reposters", method: "GET", kind: "read", path: "/2/tweets/:id/retweeted_by", grant: "read", usd: 0.010, unit: "resource", query: ["max_results", "pagination_token"], results: [1, 100], fixed: USER_FIELDS },
  // Search
  { name: "search_recent", method: "GET", kind: "read", path: "/2/tweets/search/recent", grant: "read", usd: 0.005, unit: "resource", query: SEARCH, results: [10, 100], fixed: POST_QUERY },
  { name: "search_all", method: "GET", kind: "read", path: "/2/tweets/search/all", grant: "read", usd: 0.005, unit: "resource", query: SEARCH, results: [10, 100], fixed: POST_QUERY },
  { name: "counts_recent", method: "GET", kind: "read", path: "/2/tweets/counts/recent", grant: "read", usd: 0.005, unit: "request", query: COUNTS, fixed: {} },
  { name: "counts_all", method: "GET", kind: "read", path: "/2/tweets/counts/all", grant: "read", usd: 0.010, unit: "request", query: COUNTS, fixed: {} },
  // Who follows whom, who is blocked or muted (x_users reads; "engage" because X's scopes for them live there)
  { name: "followers", method: "GET", kind: "read", path: "/2/users/:me/followers", grant: "engage", scopes: ["follows.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  { name: "following", method: "GET", kind: "read", path: "/2/users/:me/following", grant: "engage", scopes: ["follows.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  { name: "user_followers", method: "GET", kind: "read", path: "/2/users/:id/followers", grant: "engage", scopes: ["follows.read"], usd: 0.010, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  { name: "user_following", method: "GET", kind: "read", path: "/2/users/:id/following", grant: "engage", scopes: ["follows.read"], usd: 0.010, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  { name: "blocked", method: "GET", kind: "read", path: "/2/users/:me/blocking", grant: "engage", scopes: ["block.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  { name: "muted", method: "GET", kind: "read", path: "/2/users/:me/muting", grant: "engage", scopes: ["mute.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 1000], fixed: USER_FIELDS },
  // Writes (x_engage, x_users): held for the user's approval, charged per request
  { name: "like", method: "POST", kind: "write", path: "/2/users/:me/likes", grant: "engage", scopes: ["like.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { id: "tweet_id" } },
  { name: "unlike", method: "DELETE", kind: "write", path: "/2/users/:me/likes/:id", grant: "engage", scopes: ["like.write"], usd: 0.010, unit: "request", query: [], fixed: {} },
  { name: "repost", method: "POST", kind: "write", path: "/2/users/:me/retweets", grant: "engage", scopes: ["tweet.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { id: "tweet_id" } },
  { name: "unrepost", method: "DELETE", kind: "write", path: "/2/users/:me/retweets/:id", grant: "engage", scopes: ["tweet.write"], usd: 0.010, unit: "request", query: [], fixed: {} },
  { name: "bookmark", method: "POST", kind: "write", path: "/2/users/:me/bookmarks", grant: "engage", scopes: ["bookmark.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { id: "tweet_id" } },
  { name: "unbookmark", method: "DELETE", kind: "write", path: "/2/users/:me/bookmarks/:id", grant: "engage", scopes: ["bookmark.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  { name: "delete_post", method: "DELETE", kind: "write", path: "/2/tweets/:id", grant: "publish", scopes: ["tweet.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  { name: "hide_reply", method: "PUT", kind: "write", path: "/2/tweets/:id/hidden", grant: "engage", scopes: ["tweet.moderate.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { hidden: "hidden" } },
  { name: "follow", method: "POST", kind: "write", path: "/2/users/:me/following", grant: "engage", scopes: ["follows.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { id: "target_user_id" } },
  { name: "unfollow", method: "DELETE", kind: "write", path: "/2/users/:me/following/:id", grant: "engage", scopes: ["follows.write"], usd: 0.010, unit: "request", query: [], fixed: {} },
  { name: "block", method: "POST", kind: "write", path: "/2/users/:me/blocking", grant: "engage", scopes: ["block.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { id: "target_user_id" } },
  { name: "unblock", method: "DELETE", kind: "write", path: "/2/users/:me/blocking/:id", grant: "engage", scopes: ["block.write"], usd: 0.010, unit: "request", query: [], fixed: {} },
  { name: "mute", method: "POST", kind: "write", path: "/2/users/:me/muting", grant: "engage", scopes: ["mute.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { id: "target_user_id" } },
  { name: "unmute", method: "DELETE", kind: "write", path: "/2/users/:me/muting/:id", grant: "engage", scopes: ["mute.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  // Direct messages (x_dm): reads charged per event returned, a message sent per request.
  // `:conversation` is X's conversation id (two user ids joined by a dash for a 1:1, digits for a group).
  { name: "dm_events", method: "GET", kind: "read", path: "/2/dm_events", grant: "messages", scopes: ["dm.read"], usd: 0.010, unit: "resource", query: ["max_results", "pagination_token", "event_types"], results: [1, 100], fixed: DM_QUERY },
  { name: "dm_with", method: "GET", kind: "read", path: "/2/dm_conversations/with/:id/dm_events", grant: "messages", scopes: ["dm.read"], usd: 0.010, unit: "resource", query: ["max_results", "pagination_token", "event_types"], results: [1, 100], fixed: DM_QUERY },
  { name: "dm_conversation", method: "GET", kind: "read", path: "/2/dm_conversations/:conversation/dm_events", grant: "messages", scopes: ["dm.read"], usd: 0.010, unit: "resource", query: ["max_results", "pagination_token", "event_types"], results: [1, 100], fixed: DM_QUERY },
  { name: "dm_send_user", method: "POST", kind: "write", path: "/2/dm_conversations/with/:id/messages", grant: "messages", scopes: ["dm.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { text: "text" } },
  { name: "dm_send_conversation", method: "POST", kind: "write", path: "/2/dm_conversations/:conversation/messages", grant: "messages", scopes: ["dm.write"], usd: 0.015, unit: "request", query: [], fixed: {}, body: { text: "text" } },
  // Lists (x_lists): the account's own ones at the owned-read price, any list's posts and members at theirs; managing one is held.
  { name: "lists_owned", method: "GET", kind: "read", path: "/2/users/:me/owned_lists", grant: "read", scopes: ["list.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 100], fixed: LIST_FIELDS },
  { name: "lists_followed", method: "GET", kind: "read", path: "/2/users/:me/followed_lists", grant: "read", scopes: ["list.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 100], fixed: LIST_FIELDS },
  { name: "lists_memberships", method: "GET", kind: "read", path: "/2/users/:me/list_memberships", grant: "read", scopes: ["list.read"], usd: 0.001, unit: "resource", query: USER_PAGE, results: [1, 100], fixed: LIST_FIELDS },
  { name: "lists_pinned", method: "GET", kind: "read", path: "/2/users/:me/pinned_lists", grant: "read", scopes: ["list.read"], usd: 0.001, unit: "resource", query: [], fixed: LIST_FIELDS },
  { name: "list", method: "GET", kind: "read", path: "/2/lists/:id", grant: "read", scopes: ["list.read"], usd: 0.005, unit: "resource", query: [], fixed: LIST_FIELDS },
  { name: "list_posts", method: "GET", kind: "read", path: "/2/lists/:id/tweets", grant: "read", scopes: ["list.read"], usd: 0.005, unit: "resource", query: USER_PAGE, results: [1, 100], fixed: POST_QUERY },
  { name: "list_members", method: "GET", kind: "read", path: "/2/lists/:id/members", grant: "read", scopes: ["list.read"], usd: 0.010, unit: "resource", query: USER_PAGE, results: [1, 100], fixed: USER_FIELDS },
  { name: "list_create", method: "POST", kind: "write", path: "/2/lists", grant: "engage", scopes: ["list.write"], usd: 0.010, unit: "request", query: [], fixed: {}, body: { name: "name", description: "description", private: "private" } },
  { name: "list_update", method: "PUT", kind: "write", path: "/2/lists/:list", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { name: "name", description: "description", private: "private" } },
  { name: "list_delete", method: "DELETE", kind: "write", path: "/2/lists/:list", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  { name: "list_add_member", method: "POST", kind: "write", path: "/2/lists/:list/members", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { user: "user_id" } },
  { name: "list_remove_member", method: "DELETE", kind: "write", path: "/2/lists/:list/members/:user", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  { name: "list_follow", method: "POST", kind: "write", path: "/2/users/:me/followed_lists", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { list: "list_id" } },
  { name: "list_unfollow", method: "DELETE", kind: "write", path: "/2/users/:me/followed_lists/:list", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  { name: "list_pin", method: "POST", kind: "write", path: "/2/users/:me/pinned_lists", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {}, body: { list: "list_id" } },
  { name: "list_unpin", method: "DELETE", kind: "write", path: "/2/users/:me/pinned_lists/:list", grant: "engage", scopes: ["list.write"], usd: 0.005, unit: "request", query: [], fixed: {} },
  // Spaces, communities and trends (x_explore): reads only.
  { name: "space", method: "GET", kind: "read", path: "/2/spaces/:id", grant: "read", scopes: ["space.read"], usd: 0.005, unit: "resource", query: [], fixed: SPACE_QUERY },
  { name: "spaces_by", method: "GET", kind: "read", path: "/2/spaces/by/creator_ids", grant: "read", scopes: ["space.read"], usd: 0.005, unit: "resource", query: ["user_ids"], fixed: SPACE_QUERY },
  { name: "spaces_search", method: "GET", kind: "read", path: "/2/spaces/search", grant: "read", scopes: ["space.read"], usd: 0.005, unit: "resource", query: ["query", "state", "max_results"], results: [1, 100], fixed: SPACE_QUERY },
  { name: "community", method: "GET", kind: "read", path: "/2/communities/:id", grant: "read", usd: 0.005, unit: "resource", query: [], fixed: COMMUNITY_FIELDS },
  { name: "communities_search", method: "GET", kind: "read", path: "/2/communities/search", grant: "read", usd: 0.005, unit: "resource", query: ["query", "max_results", "pagination_token"], results: [10, 100], fixed: COMMUNITY_FIELDS },
  { name: "trends", method: "GET", kind: "read", path: "/2/trends/by/woeid/:id", grant: "read", usd: 0.010, unit: "request", query: ["max_trends"], fixed: {} },
  { name: "trends_personalized", method: "GET", kind: "read", path: "/2/users/personalized_trends", grant: "read", usd: 0.010, unit: "request", query: [], fixed: {} },
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
export const opsPublic = (): { name: string; kind: XOp["kind"]; grant: XGrant; scopes: string[]; usd: number; unit: XOp["unit"]; results?: [number, number] }[] =>
  OPS.map((o) => ({ name: o.name, kind: o.kind, grant: o.grant, scopes: o.scopes ?? [], usd: o.usd, unit: o.unit, ...(o.results ? { results: o.results } : {}) }));

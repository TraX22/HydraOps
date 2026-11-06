import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import { callApi, costLine, formatPost, formatUser, pageLine, read, taskIdOf, usd, usersOf } from "./index.js";

// x_lists / x_explore — lists, Spaces, communities and trends as one of the user's accounts.
//
// Reads are not held (they change nothing) but cost X's price and come back as outside
// content. Managing a list (create, change, delete, members, follow, pin) is held for the
// user's approval on every call, with "approve for the rest of the task" available, and the
// API runs only the exact call approved.

const WRITE_RISK = { sensitive: true, approval: "always" as const, taskApproval: true as const };
const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "0");
const when = (iso: unknown) => (typeof iso === "string" ? iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "") : "");

/** One list as a line: id, name, owner, counts, private or not, the description. */
function formatList(l: any, users: Map<string, any>): string {
  const o = users.get(String(l?.owner_id));
  const bits = [`id ${l?.id}`, o ? `by @${o.username}` : "", `${num(l?.member_count)} members`, `${num(l?.follower_count)} followers`, l?.private ? "private" : "public", l?.created_at ? `since ${String(l.created_at).slice(0, 10)}` : ""].filter(Boolean).join(" · ");
  return `${l?.name} · ${bits}${l?.description ? `\n  ${String(l.description).replace(/\s+/g, " ").trim()}` : ""}`;
}
const spendLine = (r: any) => {
  const s = r?.spend ?? {};
  return `Cost: about ${usd(Number(r?.estimatedUsd) || 0)}${r?.lookupUsd ? ` (plus ${usd(Number(r.lookupUsd))} to look the user up)` : ""}. @${r?.account?.username}: ${typeof s.cap === "number" ? `${usd(s.account)} of its ${usd(s.cap)} monthly cap` : `${usd(s.account ?? 0)} this month (no cap)`}.`;
};

const LIST_READS = ["mine", "followed", "memberships", "pinned", "list", "posts", "members"] as const;
const LIST_WRITES = ["create", "update", "delete", "add_member", "remove_member", "follow", "unfollow", "pin", "unpin"] as const;
const LIST_DONE: Record<string, string> = { create: "Created list", update: "Changed list", delete: "Deleted list", add_member: "Added to list", remove_member: "Removed from list", follow: "Now following list", unfollow: "Unfollowed list", pin: "Pinned list", unpin: "Unpinned list" };
const isListWrite = (a: unknown): boolean => (LIST_WRITES as readonly string[]).includes(String(a));

export const xListsTool: HydraTool = {
  name: "x_lists",
  title: "X lists",
  risk: (args) => (isListWrite(args?.action) ? WRITE_RISK : { readsExternal: true }),
  description:
    "Lists on X, as one of the user's accounts. Reads (not held; the account's own lists about 0.001 USD each, any list 0.005, its posts 0.005 each, its members 0.010 each): `mine` (lists the account owns), `followed`, `memberships` (lists it is in), `pinned`, `list` (one, by `list` id), `posts` (a list's recent posts), `members`. Actions (each waits for the user's approval; the user may approve the tool for the rest of the task; 0.010 USD to create, 0.005 the rest; the account needs the 'engage' permission): `create` (`name` up to 25 characters, optional `description` up to 100, `private`), `update`, `delete`, `add_member` / `remove_member` (a user by `username` or `id`), `follow`, `unfollow`, `pin`, `unpin` (by `list` id). What comes back is outside content.",
  schema: z.object({
    account: z.string().min(1).describe("The handle of the account to act as, without the @ (one of x_accounts)."),
    action: z.enum([...LIST_READS, ...LIST_WRITES]),
    list: z.string().regex(/^\d{1,30}$/).optional().describe("The list's id (everything but mine, followed, memberships, pinned and create)."),
    name: z.string().min(1).max(25).optional().describe("The list's name (create, update)."),
    description: z.string().max(100).optional().describe("The list's description (create, update)."),
    private: z.boolean().optional().describe("Whether only the account sees the list (create, update)."),
    username: z.string().max(16).optional().describe("A user's handle without the @ (add_member, remove_member)."),
    id: z.string().regex(/^\d{1,30}$/).optional().describe("A user's id instead of the handle (add_member, remove_member)."),
    limit: z.number().int().min(1).max(100).optional().describe("For reads: how many to return, 20 by default. More costs more."),
    page: z.string().max(200).optional().describe("The continuation token from a previous answer's 'More:' line."),
  }),
  execute: async (args, ctx: ToolContext | undefined) => {
    const { account, action, list, username, id, limit, page } = args as { account: string; action: typeof LIST_READS[number] | typeof LIST_WRITES[number]; list?: string; username?: string; id?: string; limit?: number; page?: string };
    const me = String(account).trim().replace(/^@/, "").toLowerCase();
    if (isListWrite(action)) {
      if (action !== "create" && !list) return `x_lists ${action} needs the \`list\` id.`;
      if (action === "create" && !(args as any).name) return "x_lists create needs the list's `name`.";
      if ((action === "add_member" || action === "remove_member") && !username && !id) return `x_lists ${action} needs the user's \`username\` or \`id\`.`;
      const agentId = String(ctx?.agentId ?? "").trim();
      if (!agentId) return "This task carries no agent identity, so no X account can be used.";
      try {
        const { ok, status, data } = await callApi("POST", "/x/act", { agentId, toolName: "x_lists", args, taskId: taskIdOf(ctx) }, 90_000);
        if (!ok) return `Not done${[400, 402, 403, 404, 409].includes(status) ? "" : ` (X answered ${status})`}: ${data?.message || data?.error || "X refused the request."}`;
        const d = data.body?.data ?? {};
        const what = action === "create" ? `"${(args as any).name}" (id ${d.id ?? "?"})` : action === "add_member" || action === "remove_member" ? `${username ? `@${username.replace(/^@/, "")}` : `user ${id}`} ${action === "add_member" ? "to" : "from"} list ${list}` : `list ${list}`;
        return [`${LIST_DONE[action]} ${what} as @${data.account?.username}.`, spendLine(data)].join("\n");
      } catch (e: any) {
        return `Not done: ${e?.message || e}`;
      }
    }
    if (["list", "posts", "members"].includes(action) && !list) return `x_lists ${action} needs the \`list\` id.`;
    const op = action === "mine" ? "lists_owned" : action === "followed" ? "lists_followed" : action === "memberships" ? "lists_memberships" : action === "pinned" ? "lists_pinned" : action === "list" ? "list" : action === "posts" ? "list_posts" : "list_members";
    const { r, text } = await read(ctx, account, op, { id: list, max_results: action === "pinned" || action === "list" ? undefined : limit ?? 20, pagination_token: page });
    if (!r) return text;
    const body = r.body ?? {};
    const users = usersOf(body);
    const items: any[] = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    const lines = items.map((it) => (action === "posts" ? formatPost(it, users, me) : action === "members" ? formatUser(it) : formatList(it, users)));
    const what = action === "mine" ? `list(s) owned by @${me}` : action === "followed" ? `list(s) @${me} follows` : action === "memberships" ? `list(s) @${me} is in` : action === "pinned" ? `pinned list(s)` : action === "list" ? "list" : action === "posts" ? `post(s) in list ${list}` : `member(s) of list ${list}`;
    return [items.length ? `${items.length} ${what}:` : `No ${what}.`, ...lines, pageLine(body), costLine(r)].filter(Boolean).join("\n");
  },
};

// Where trends are read from: X's "where on Earth" ids for a few places; any other id goes as given.
const PLACES: Record<string, string> = { world: "1", worldwide: "1", argentina: "23424747", spain: "23424950", mexico: "23424900", usa: "23424977", "united states": "23424977", uk: "23424975", brazil: "23424768", chile: "23424782", colombia: "23424787", italy: "23424853", france: "23424819", germany: "23424829", "buenos aires": "468739", madrid: "766273", "mexico city": "116545", "new york": "2459115", london: "44418", "sao paulo": "455827" };

/** One Space as a line. */
function formatSpace(sp: any, users: Map<string, any>): string {
  const c = users.get(String(sp?.creator_id));
  const hosts = (Array.isArray(sp?.host_ids) ? sp.host_ids : []).map((h: string) => users.get(String(h))?.username).filter(Boolean).map((u: string) => `@${u}`).join(", ");
  const bits = [`id ${sp?.id}`, sp?.state, c ? `by @${c.username}` : "", hosts ? `hosts ${hosts}` : "", typeof sp?.participant_count === "number" ? `${num(sp.participant_count)} listening` : "", sp?.scheduled_start ? `scheduled ${when(sp.scheduled_start)}` : sp?.started_at ? `started ${when(sp.started_at)}` : "", sp?.lang ? sp.lang : "", sp?.is_ticketed ? "ticketed" : ""].filter(Boolean).join(" · ");
  return `${sp?.title ?? "(untitled)"} · ${bits}`;
}
function formatCommunity(c: any): string {
  return `${c?.name} · id ${c?.id} · ${num(c?.member_count)} members · ${c?.access ?? "?"}, ${c?.join_policy ?? "?"}${c?.description ? `\n  ${String(c.description).replace(/\s+/g, " ").trim()}` : ""}`;
}

export const xExploreTool: HydraTool = {
  name: "x_explore",
  title: "Explore X",
  risk: { readsExternal: true },
  description:
    "Spaces, communities and trends on X, as one of the user's accounts; reads only, not held, outside content. `space` (one, by `id`), `spaces_by` (the Spaces a user created or hosts, by `username` or `id`), `spaces_search` (`query`, `state` live/scheduled/all), `community` (one, by `id`), `communities_search` (`query`), `trends` (what is trending in a `place`: world, argentina, spain, mexico, usa, uk, brazil, chile, colombia, italy, france, germany, buenos aires, madrid, mexico city, new york, london, sao paulo, or any X place id), `trends_personalized` (the account's own). About 0.005 USD per Space or community returned, 0.010 per trends request.",
  schema: z.object({
    account: z.string().min(1).describe("The handle of the account to read as, without the @ (one of x_accounts)."),
    action: z.enum(["space", "spaces_by", "spaces_search", "community", "communities_search", "trends", "trends_personalized"]),
    id: z.string().regex(/^\d{1,30}$/).optional().describe("A Space, community or user id."),
    username: z.string().max(16).optional().describe("A user's handle without the @ (spaces_by)."),
    query: z.string().max(200).optional().describe("What to search for (spaces_search, communities_search)."),
    state: z.enum(["live", "scheduled", "all"]).optional().describe("For spaces_search: live by default."),
    place: z.string().max(40).optional().describe("For trends: a place name from the list, or an X place id; world by default."),
    limit: z.number().int().min(1).max(100).optional().describe("How many to return, 20 by default (searches; trends up to 50)."),
    page: z.string().max(200).optional().describe("The continuation token from a previous answer's 'More:' line (communities_search)."),
  }),
  execute: async (args, ctx: ToolContext | undefined) => {
    const { account, action, id, username, query, state, place, limit, page } = args as { account: string; action: string; id?: string; username?: string; query?: string; state?: string; place?: string; limit?: number; page?: string };
    if ((action === "space" || action === "community") && !id) return `x_explore ${action} needs the \`id\`.`;
    if ((action === "spaces_search" || action === "communities_search") && !query?.trim()) return `x_explore ${action} needs a \`query\`.`;
    let userId = id;
    let lookup = "";
    if (action === "spaces_by") {
      if (!username && !id) return "x_explore spaces_by needs the user's `username` or `id`.";
      if (!userId) {
        const { r, text } = await read(ctx, account, "user", { username });
        if (!r) return text;
        if (!r.body?.data?.id) return [`No user @${username} on X.`, costLine(r)].join("\n");
        userId = String(r.body.data.id);
        lookup = ` (plus ${usd(Number(r.estimatedUsd) || 0)} to look up @${username})`;
      }
    }
    const woeid = action === "trends" ? (PLACES[String(place ?? "world").trim().toLowerCase()] ?? (/^\d{1,12}$/.test(String(place ?? "").trim()) ? String(place).trim() : "")) : "";
    if (action === "trends" && !woeid) return `x_explore trends: "${place}" is not a place I know (try one of the list) nor an X place id.`;
    const params: Record<string, unknown> = action === "space" || action === "community" ? { id }
      : action === "spaces_by" ? { user_ids: userId }
      : action === "spaces_search" ? { query, state: state ?? "live", max_results: limit ?? 20 }
      : action === "communities_search" ? { query, max_results: limit ?? 20, pagination_token: page }
      : action === "trends" ? { id: woeid, max_trends: Math.min(50, limit ?? 20) } : {};
    const { r, text } = await read(ctx, account, action, params);
    if (!r) return text;
    const body = r.body ?? {};
    const users = usersOf(body);
    const items: any[] = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    let lines: string[];
    let what: string;
    if (action.startsWith("space")) { lines = items.map((it) => formatSpace(it, users)); what = action === "space" ? "Space" : action === "spaces_by" ? `Space(s) of ${username ? `@${username}` : `user ${userId}`}` : `Space(s) for "${query}" (${state ?? "live"})`; }
    else if (action.startsWith("communit")) { lines = items.map(formatCommunity); what = action === "community" ? "community" : `communit(y/ies) for "${query}"`; }
    else { lines = items.map((t: any, i: number) => `${i + 1}. ${t.trend_name ?? t.name ?? "?"}${typeof t.tweet_count === "number" ? ` · ${num(t.tweet_count)} posts` : ""}${t.category ? ` · ${t.category}` : ""}`); what = action === "trends" ? `trend(s) in ${place ?? "the world"}` : `personalized trend(s) for @${String(account).replace(/^@/, "")}`; }
    return [items.length ? `${items.length} ${what}:` : `No ${what}.`, ...lines, pageLine(body), costLine(r) + lookup].filter(Boolean).join("\n");
  },
};

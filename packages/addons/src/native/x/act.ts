import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import { callApi, costLine, formatUser, pageLine, read, taskIdOf, usd } from "./index.js";

// x_engage / x_users — acting on X as one of the user's accounts.
//
// A like, a repost, a bookmark, a follow, a block, a mute, their undoings, deleting an own
// post, hiding a reply: each is held for the user's approval on every call (the user may
// approve a tool for the rest of the task, so a run of likes asks once), and the API runs
// it only as the execution of that approved call. The reads of x_users (who follows whom,
// who is blocked or muted) are not held; they cost, like every read, and come back as
// outside content.

const WRITE_RISK = { sensitive: true, approval: "always" as const, taskApproval: true as const };

/** One action through the API: the approval check is the API's; a refusal comes back as text the agent can act on. */
async function act(ctx: ToolContext | undefined, toolName: string, args: Record<string, unknown>, account: string, op: string, params: Record<string, unknown>): Promise<{ r?: any; text?: string }> {
  const agentId = String(ctx?.agentId ?? "").trim();
  if (!agentId) return { text: "This task carries no agent identity, so no X account can be used." };
  try {
    const { ok, status, data } = await callApi("POST", "/x/act", { agentId, toolName, args, account: String(account).trim().replace(/^@/, ""), op, params, taskId: taskIdOf(ctx) }, 90_000);
    if (!ok) return { text: `Not done${[400, 402, 403, 404, 409].includes(status) ? "" : ` (X answered ${status})`}: ${data?.message || data?.error || "X refused the request."}` };
    return { r: data };
  } catch (e: any) {
    return { text: `Not done: ${e?.message || e}` };
  }
}
const spendLine = (r: any) => {
  const s = r?.spend ?? {};
  return `Cost: about ${usd(Number(r?.estimatedUsd) || 0)}. @${r?.account?.username}: ${typeof s.cap === "number" ? `${usd(s.account)} of its ${usd(s.cap)} monthly cap` : `${usd(s.account ?? 0)} this month (no cap)`}.`;
};

const ENGAGE_ACTIONS = ["like", "unlike", "repost", "unrepost", "bookmark", "unbookmark", "delete", "hide_reply", "unhide_reply"] as const;
const ENGAGE_OP: Record<string, string> = { like: "like", unlike: "unlike", repost: "repost", unrepost: "unrepost", bookmark: "bookmark", unbookmark: "unbookmark", delete: "delete_post", hide_reply: "hide_reply", unhide_reply: "hide_reply" };
const ENGAGE_DONE: Record<string, string> = { like: "Liked", unlike: "Unliked", repost: "Reposted", unrepost: "Repost removed from", bookmark: "Bookmarked", unbookmark: "Bookmark removed from", delete: "Deleted", hide_reply: "Hidden", unhide_reply: "Shown again" };

export const xEngageTool: HydraTool = {
  name: "x_engage",
  title: "Engage on X",
  risk: WRITE_RISK,
  description:
    "Act on a post as one of the user's X accounts: `like`, `unlike`, `repost`, `unrepost`, `bookmark`, `unbookmark`, `delete` (one of the account's OWN posts), `hide_reply` / `unhide_reply` (a reply to one of the account's posts). Every call waits for the user's approval (they may approve the tool for the rest of the task) and costs about 0.015 USD (0.005 to 0.010 to undo, bookmark or delete). Use the post id from x_read or x_search; the account needs the 'engage' permission (deleting needs 'publish').",
  schema: z.object({
    account: z.string().min(1).describe("The handle of the account to act as, without the @ (one of x_accounts)."),
    action: z.enum(ENGAGE_ACTIONS),
    id: z.string().regex(/^\d{1,30}$/).describe("The post's id."),
  }),
  execute: async (args, ctx) => {
    const { account, action, id } = args as { account: string; action: typeof ENGAGE_ACTIONS[number]; id: string };
    const params: Record<string, unknown> = action === "hide_reply" ? { id, hidden: true } : action === "unhide_reply" ? { id, hidden: false } : { id };
    const { r, text } = await act(ctx, "x_engage", args, account, ENGAGE_OP[action], params);
    if (!r) return text;
    const d = r.body?.data ?? {};
    const undone = (action === "unlike" && d.liked === true) || (action === "unrepost" && d.retweeted === true) || (action === "unbookmark" && d.bookmarked === true);
    return [`${ENGAGE_DONE[action]} post ${id} as @${r.account?.username}${undone ? " (X says it still is; try again later)" : ""}.`, spendLine(r)].join("\n");
  },
};

const USER_READS = ["followers", "following", "user_followers", "user_following", "blocked", "muted"] as const;
const USER_WRITES = ["follow", "unfollow", "block", "unblock", "mute", "unmute"] as const;
const USER_DONE: Record<string, string> = { follow: "Now following", unfollow: "Unfollowed", block: "Blocked", unblock: "Unblocked", mute: "Muted", unmute: "Unmuted" };
type UserAction = typeof USER_READS[number] | typeof USER_WRITES[number];
const isUserWrite = (a: unknown): boolean => (USER_WRITES as readonly string[]).includes(String(a));

export const xUsersTool: HydraTool = {
  name: "x_users",
  title: "X users",
  // Reading who follows whom brings outside content; following, blocking or muting acts under the user's name.
  risk: (args) => (isUserWrite(args?.action) ? WRITE_RISK : { readsExternal: true }),
  description:
    "Relations with other X users, as one of the user's accounts. Reads (not held, they cost: about 0.001 USD per own follower or following, 0.010 per other user): `followers`, `following` (the account's own), `user_followers`, `user_following` (another user's, by `username` or `id`), `blocked`, `muted`. Actions (each waits for the user's approval; the user may approve the tool for the rest of the task; about 0.015 USD, 0.005 to 0.010 to undo): `follow`, `unfollow`, `block`, `unblock`, `mute`, `unmute` a user by `username` or `id`. The account needs the 'engage' permission. A profile itself is read with x_read (action user). What comes back is outside content.",
  schema: z.object({
    account: z.string().min(1).describe("The handle of the account to act as, without the @ (one of x_accounts)."),
    action: z.enum([...USER_READS, ...USER_WRITES]),
    username: z.string().max(16).optional().describe("The other user's handle without the @ (user_followers, user_following, follow, unfollow, block, unblock, mute, unmute)."),
    id: z.string().regex(/^\d{1,30}$/).optional().describe("The other user's id, instead of the handle."),
    limit: z.number().int().min(1).max(1000).optional().describe("For reads: how many to return, 20 by default. More costs more."),
    page: z.string().max(200).optional().describe("The continuation token from a previous answer's 'More:' line."),
  }),
  execute: async (args, ctx) => {
    const { account, action, username, id, limit, page } = args as { account: string; action: UserAction; username?: string; id?: string; limit?: number; page?: string };
    const needsUser = !["followers", "following", "blocked", "muted"].includes(action);
    if (needsUser && !username && !id) return `x_users ${action} needs the other user's \`username\` or \`id\`.`;
    // The other user's id, looked up by handle when needed (a profile read X charges for).
    let userId = id;
    let lookup = "";
    if (needsUser && !userId) {
      const { r, text } = await read(ctx, account, "user", { username });
      if (!r) return text;
      if (!r.body?.data?.id) return [`No user @${username} on X.`, costLine(r)].join("\n");
      userId = String(r.body.data.id);
      lookup = ` (plus ${usd(Number(r.estimatedUsd) || 0)} to look up @${username})`;
    }
    if (isUserWrite(action)) {
      const { r, text } = await act(ctx, "x_users", args, account, action, { id: userId });
      if (!r) return text;
      return [`${USER_DONE[action]} ${username ? `@${username}` : `user ${userId}`} as @${r.account?.username}.`, spendLine(r) + lookup].join("\n");
    }
    const { r, text } = await read(ctx, account, action, { id: userId, max_results: limit ?? 20, pagination_token: page });
    if (!r) return text;
    const body = r.body ?? {};
    const items: any[] = Array.isArray(body.data) ? body.data : [];
    const who = action.startsWith("user_") ? `@${username ?? userId}` : `@${r.account?.username}`;
    const what = action.replace("user_", "");
    return [items.length ? `${items.length} ${what === "blocked" ? "blocked user" : what === "muted" ? "muted user" : what === "followers" ? "follower" : "followed user"}(s) of ${who}:` : `No ${what} for ${who}.`, ...items.map(formatUser), pageLine(body), costLine(r) + lookup].filter(Boolean).join("\n");
  },
};

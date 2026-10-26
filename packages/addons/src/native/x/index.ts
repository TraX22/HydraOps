import { z } from "zod";
import { HydraTool } from "../../types.js";

// x_accounts / x_post — publishing on the user's X accounts.
//
// The agent never sees a token or the app's secret: it calls the local HydraOps API
// (loopback), which checks that THIS agent (the worker's identity, never the model's
// word) may use the account it names, resolves the attachments, and hands the parts to
// the key-proxy, the one process holding the tokens. x_post is held for the user's
// approval on every call, whatever the task read: a post goes out under the user's name.

const apiUrl = () =>
  (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

/** X's length rule: 280 weighted characters, every URL counting as 23. */
export function xLength(text: string): number {
  return text.replace(/https?:\/\/\S+/gi, "x".repeat(23)).length;
}

async function callApi(method: "GET" | "POST", p: string, body?: unknown, timeoutMs = 180_000): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`${apiUrl()}/api${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export const xAccountsTool: HydraTool = {
  name: "x_accounts",
  title: "X accounts",
  // Reads this installation's own settings: nothing from outside, nothing sensitive.
  risk: {},
  description:
    "The X accounts this agent may publish on (the user assigned them in Tools → X), with their handles. Call it before writing a post for X: with one account, use it; with several and a request that does not say which, ask the user; with none, say so instead of improvising.",
  schema: z.object({}),
  execute: async (_args, ctx) => {
    const agentId = String(ctx?.agentId ?? "").trim();
    if (!agentId) return "This task carries no agent identity, so no X account can be used.";
    try {
      const { ok, data } = await callApi("GET", `/x/accounts?agentId=${encodeURIComponent(agentId)}`);
      if (!ok) return `X is not available right now${data?.message ? `: ${data.message}` : "."}`;
      if (data.enabled === false) return "Publishing on X is switched off in Tools → X.";
      const list: any[] = Array.isArray(data.accounts) ? data.accounts : [];
      if (!list.length) return `No X account is enabled for ${agentId}. The user assigns accounts to agents in Tools → X.`;
      return [
        `X accounts ${agentId} may publish on:`,
        ...list.map((a) => `- @${a.username} (${a.name})${a.premium ? " — Premium: long posts allowed" : ""}${a.status !== "connected" ? " — session expired, needs reconnecting in Tools → X" : ""}`),
        "Limits: 280 weighted characters per part (a URL counts as 23) unless the account is Premium (then up to 25,000, but X shows only the start and the user has to ask for a long post explicitly); per part, up to 4 images, or one GIF, or one video (mp4, H.264 + AAC); up to 25 parts in a thread. Every x_post call waits for the user's approval; the user pays X per post (more when a part carries a link).",
      ].join("\n");
    } catch (e: any) {
      return `Could not read the X accounts: ${e?.message || e}`;
    }
  },
};

const partSchema = z.object({
  text: z.string().min(1).describe("The part's text, as it will be published. 280 weighted characters at most (a URL counts as 23)."),
  media: z.array(z.string()).max(4).optional().describe("Attachments for this part, by the file name the conversation shows (storage/uploads/<name>): up to 4 images (png, jpg, webp; 5 MB each), or ONE gif (15 MB), or ONE video (mp4 with H.264 video and AAC audio). A video or a GIF goes alone in its part."),
});

export const xPostTool: HydraTool = {
  name: "x_post",
  title: "Post on X",
  // Publishes under the user's name: every call waits for the user's approval.
  risk: { sensitive: true, approval: "always" },
  description:
    "Publish a post or a thread on one of the user's X accounts. `account` is the handle (from x_accounts); `parts` the posts in order, each a reply to the one before. It is never run without the user's approval: they see the account, every part with its length, the images or video and the cost before deciding. Give the final text, not a draft; count the characters first (280 per part, unless the account is Premium and the user asked for a long post); put links in the last part. A video is uploaded and processed by X before the post goes out, which can take minutes. The answer carries the link to the published post.",
  schema: z.object({
    account: z.string().min(1).describe("The handle of the account to publish on, without the @ (one of x_accounts)."),
    parts: z.array(partSchema).min(1).max(25).describe("The post, or the parts of the thread in order."),
  }),
  execute: async ({ account, parts }, ctx) => {
    const agentId = String(ctx?.agentId ?? "").trim();
    if (!agentId) return "This task carries no agent identity, so nothing can be published.";
    // The 280 rule is X's for a non-Premium account; a Premium one takes long posts (up to 25,000).
    let premium = false;
    try {
      const acc = await callApi("GET", `/x/accounts?agentId=${encodeURIComponent(agentId)}`);
      const wanted = String(account).trim().replace(/^@/, "").toLowerCase();
      premium = acc.ok && (acc.data?.accounts ?? []).some((a: any) => String(a.username).toLowerCase() === wanted && a.premium === true);
    } catch { /* the API decides below anyway */ }
    const limit = premium ? 25_000 : 280;
    const tooLong = (parts as { text: string }[]).map((p, i) => ({ i: i + 1, n: xLength(p.text) })).filter((p) => p.n > limit);
    if (tooLong.length) return `Not published: part${tooLong.length > 1 ? "s" : ""} ${tooLong.map((p) => `${p.i} (${p.n} characters)`).join(", ")} over the ${limit}-character limit${premium ? "" : " of this account (a Premium account could take a long post)"}. Shorten and call again.`;
    const hasVideo = (parts as { media?: string[] }[]).some((p) => (p.media ?? []).some((m) => /\.mp4$/i.test(m)));
    try {
      const { ok, status, data } = await callApi("POST", "/x/post", { agentId, account, parts }, hasVideo ? 20 * 60_000 : 180_000);
      if (!ok) return `Not published${status === 403 || status === 404 || status === 409 || status === 400 ? "" : ` (X answered ${status})`}: ${data?.message || data?.error || "X refused the post."}`;
      const urls: string[] = Array.isArray(data.posts) ? data.posts.map((p: any) => p.url) : [];
      return [
        `Published as @${data.username}: ${data.url}`,
        urls.length > 1 ? `Thread of ${urls.length} parts: ${urls.join(" ")}` : "",
        typeof data.estimatedUsd === "number" ? `About ${data.estimatedUsd.toFixed(3)} USD charged by X to the user's developer account.` : "",
        "Tell the user the link. Deleting a post is not a tool you have: if they want it gone, they do it on X.",
      ].filter(Boolean).join("\n");
    } catch (e: any) {
      return `Not published: ${e?.message || e}`;
    }
  },
};

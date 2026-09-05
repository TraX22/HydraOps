import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";

// recall — episodic memory: let an agent search its own past completed tasks
// beyond the recent history already present in context. The actual search is a
// worker-bound closure (ToolContext.searchPastTasks) with the agent identity
// already applied, so an agent can only ever look into ITS OWN conversations.
// Companion of `remember`: remember keeps curated durable facts, recall digs
// up what actually happened.

const MAX_QUERY_CHARS = 200;

async function recall(query: string, ctx?: ToolContext): Promise<string> {
  if (!ctx?.searchPastTasks) {
    return "Recall is not available in this run: no task-history search is attached.";
  }
  const q = query.trim();
  if (!q) return "Nothing to search: the query is empty.";
  if (q.length > MAX_QUERY_CHARS) {
    return `The query is too long (${q.length} chars, max ${MAX_QUERY_CHARS}). Use a few keywords, not a full sentence.`;
  }

  let hits;
  try {
    hits = await ctx.searchPastTasks(q, 5);
  } catch (e: any) {
    return `Could not search past tasks: ${e?.message || e}`;
  }
  if (!hits || hits.length === 0) {
    return `No past conversations matched "${q}". Try different or fewer keywords; only completed tasks are searchable.`;
  }

  const blocks = hits.map(
    (h) => `--- ${h.date} ---\nUser asked: ${h.prompt}\nYou answered (excerpt): ${h.excerpt || "(no text result)"}`,
  );
  return `Found ${hits.length} past conversation(s) matching "${q}", best match first:\n\n${blocks.join("\n\n")}`;
}

export const recallTool: HydraTool = {
  name: "recall",
  description:
    "Search your own past conversations with the user by keywords. Use it when they refer to something from a while ago that is not in your recent history (\"what did I ask you about X last month?\", \"like we discussed before\", \"the plan we made\"). Returns the best-matching past exchanges with their dates. It only searches YOUR OWN completed tasks.",
  schema: z.object({
    query: z
      .string()
      .describe("A few search keywords (topic words, names, places — not a full sentence)."),
  }),
  execute: async ({ query }, ctx) => await recall(query, ctx),
};

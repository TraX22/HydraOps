import { z } from "zod";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { agentsDir } from "@hydraops/config";
import { HydraTool, ToolContext } from "../../types.js";

// remember — let an agent save a short note to its own permanent memory
// (<agent>.memory.md). The memory file is re-read into the system prompt on
// every task, so anything saved here applies immediately and forever. The
// target agent comes from the worker-bound ToolContext, never from the model,
// so an agent can only ever write to ITS OWN memory file.

const MAX_ENTRY_CHARS = 600;
const MAX_FILE_BYTES = 64 * 1024;

// Agent ids are directory names; keep the path join safe even though the id
// comes from the worker, not the model.
const isSafeAgentId = (id: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(id);

async function remember(text: string, ctx?: ToolContext): Promise<string> {
  const agentId = ctx?.agentId?.trim() || "";
  if (!agentId || !isSafeAgentId(agentId)) {
    return "Could not save: this run has no agent identity attached, so there is no memory file to write to.";
  }
  const entry = text.trim().replace(/\s*\n\s*/g, " ");
  if (!entry) return "Nothing to save: the note is empty.";
  if (entry.length > MAX_ENTRY_CHARS) {
    return `The note is too long (${entry.length} chars, max ${MAX_ENTRY_CHARS}). Memory holds short, durable facts — condense it to its essence and try again.`;
  }

  const file = path.join(agentsDir, agentId, `${agentId}.memory.md`);
  try {
    const size = await stat(file).then((s) => s.size).catch(() => 0);
    if (size > MAX_FILE_BYTES) {
      return "Your memory file is full (over 64 KB). Ask the user to prune old notes in the Agents view before saving new ones.";
    }
    // Keep the appended bullet on its own line even if the file has no
    // trailing newline (hand-edited files often don't).
    let prefix = "";
    if (size > 0) {
      const current = await readFile(file, "utf-8");
      if (!current.endsWith("\n")) prefix = "\n";
    }
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(file, `${prefix}- [${date}] ${entry}\n`, "utf-8");
    return "Saved to your permanent memory. It will be part of your context in every future task.";
  } catch (e: any) {
    return `Could not save to memory: ${e?.message || e}`;
  }
}

export const rememberTool: HydraTool = {
  name: "remember",
  description:
    "Save a short note to your own permanent memory, applied to every future conversation. Use it when the user asks you to remember something (\"remember that...\", \"acordate que...\") or when you learn a stable preference or fact worth keeping (their name, how they like answers, an ongoing project). Do NOT store one-off task details or things already in the conversation. One short, self-contained fact per call.",
  schema: z.object({
    text: z
      .string()
      .describe("The fact to remember — one short, self-contained sentence (user preference, standing instruction, durable context)."),
  }),
  execute: async ({ text }, ctx) => await remember(text, ctx),
};

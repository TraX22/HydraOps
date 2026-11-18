/**
 * The agent's own files (agent, soul, skill, tools, memory, heartbeat) as the block of the
 * system prompt that carries them: each file under a heading with ITS OWN name.
 *
 * `contents[i]` is the text of `types[i]`. A file that is empty or missing is left out, and
 * the files after it keep their own headings (they used to take the heading of the slot
 * they slid into, so an agent with an empty skill file got its memory under "TOOLS").
 * `skip` leaves out a file by its type (a project's chat does not carry the agent's memory).
 */
export function agentFilesPrompt(types: readonly string[], contents: readonly string[], opts: { skip?: readonly string[] } = {}): string {
  const skip = new Set(opts.skip ?? []);
  return types
    .map((type, i) => ({ type, content: contents[i] ?? "" }))
    .filter((f) => f.content.trim().length > 0 && !skip.has(f.type))
    .map((f) => `\n--- AGENT ${f.type.toUpperCase()} ---\n${f.content}`)
    .join("\n");
}

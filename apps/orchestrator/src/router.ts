import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentsDir } from "@hydraops/config";
import { generateText, resolveLLMConfig } from "@hydraops/llm";

// Content routing for the main channel.
//
// The main chat used to hand messages out in turns, so "help me with C#"
// could land on the illustrator. Each agent's role (from its agent.md) and
// worker type go into one short prompt to a fast model, which answers with
// an agent id. Nothing here may block a task: any doubt, error or timeout
// returns null and the caller falls back to round-robin.

const ROUTER_TIMEOUT_MS = 20_000;
const PROMPT_MAX_CHARS = 1_500;

const WORKER_BLURB: Record<string, string> = {
  coder: "writes and fixes code",
  general: "research, writing, analysis, general questions",
  graphic: "generates images, sprites, illustrations, game art",
  video: "generates video clips and animations",
};

export type GetGlobalConfig = (key: string, defaultValue: string) => string;

/**
 * What the agent is for, from its agent.md. Two shapes are in use: the seed
 * files carry `- **Role**: …` inline; hand-written ones open a `## Role`
 * section whose first bullet is the description. `**Description**:` is the
 * last resort.
 */
export async function agentRole(id: string): Promise<string> {
  try {
    const md = await readFile(path.join(agentsDir, id, `${id}.agent.md`), "utf-8");
    const inline = md.match(/^\s*[-*]?\s*\*\*Role\*\*\s*:\s*(.+)$/im)?.[1]?.trim();
    if (inline) return inline;
    const section = md.match(/^##\s*Role\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/im)?.[1];
    const first = section?.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (first) return first.replace(/^[-*]\s*/, "").trim();
    return md.match(/^\s*[-*]?\s*\*\*Description\*\*\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function routerSystemPrompt(lines: string[]): string {
  return (
    "You route a user's message to the single best-suited agent of a team. " +
    "Match the request to the agent's role and worker type: code → a coder; images, sprites, art → a graphic worker; " +
    "video → a video worker; research, writing, questions and everything else → a general worker whose role fits. " +
    "Answer with the agent id only, nothing else.\n\nAgents:\n" + lines.join("\n")
  );
}

/** Which candidate id the model named, or null when it named none. */
export function parseRouterAnswer(answer: string, candidates: string[]): string | null {
  const a = answer.toLowerCase();
  if (!a.trim()) return null;
  return (
    candidates.find((id) => new RegExp(`\\b${id.toLowerCase()}\\b`).test(a)) ??
    candidates.find((id) => a.includes(id.toLowerCase())) ??
    null
  );
}

export async function routeByContent(
  prompt: string,
  candidates: string[],
  workerTypeOf: (id: string) => string,
  getGlobalConfig: GetGlobalConfig,
  log: (msg: string) => void = console.log,
): Promise<string | null> {
  if (candidates.length < 2) return candidates[0] ?? null;
  const text = prompt.trim();
  if (!text) return null;

  // ROUTER_MODEL lets the router use a cheaper/faster model than the one the
  // agents answer with; otherwise the global default.
  const model = getGlobalConfig("ROUTER_MODEL", "") || getGlobalConfig("DEFAULT_MODEL", "") || process.env.DEFAULT_MODEL || "";
  if (!model) return null;
  const config = resolveLLMConfig(model, getGlobalConfig);
  if (config.provider === "leonardo") return null;

  const lines = await Promise.all(
    candidates.map(async (id) => {
      const wt = workerTypeOf(id);
      const role = await agentRole(id);
      return `- ${id}: ${role ? role + " — " : ""}${WORKER_BLURB[wt] ?? wt} (worker: ${wt})`;
    }),
  );

  try {
    const result = await Promise.race([
      generateText(config, [{ role: "user", content: text.slice(0, PROMPT_MAX_CHARS) }], routerSystemPrompt(lines)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ROUTER_TIMEOUT_MS)),
    ]);
    const answer = result?.text ?? "";
    const pick = parseRouterAnswer(answer, candidates);
    if (!pick) {
      log(`[orchestrator] router: ${answer ? `unrecognised answer "${answer.slice(0, 60)}"` : `no answer from ${config.provider}:${config.model}`} — falling back to round-robin`);
      return null;
    }
    log(`[orchestrator] router: "${text.replace(/\s+/g, " ").slice(0, 60)}" → ${pick} (${config.model})`);
    return pick;
  } catch (e: any) {
    log(`[orchestrator] router failed: ${e?.message ?? e} — falling back to round-robin`);
    return null;
  }
}

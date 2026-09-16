import type { AgentSummary } from "./types.js";

// Accent- and case-insensitive: "Lucía", "lucia" and "LUCIA" name the same agent.
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export function findAgent(agents: AgentSummary[], nameOrId: string): AgentSummary | undefined {
  const wanted = fold(nameOrId);
  return agents.find((a) => fold(a.id) === wanted || fold(a.name) === wanted);
}

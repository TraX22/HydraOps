import { z } from "zod";
import { HydraTool, ToolContext } from "../../../types.js";

// delegate_task — let an agent hand work to another HydraOps agent. It creates
// a task in the target agent's chat through the local API (loopback), exactly
// as if the user had typed it there: the orchestrator routes it to that agent,
// the reply lands in that agent's chat, and the task is born unread so the
// agent shows activity until the user opens it. Fire-and-forget: the caller
// gets a confirmation, not the result.

const apiUrl = () =>
  (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

interface AgentSummary {
  id: string;
  name: string;
}

// Accent- and case-insensitive: "Lucía", "lucia" and "LUCIA" are the same agent.
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

async function listAgents(): Promise<AgentSummary[]> {
  const res = await fetch(`${apiUrl()}/api/agents`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET /api/agents ${res.status}`);
  const raw = (await res.json()) as any[];
  return raw.map((a) => ({ id: String(a.id), name: String(a.name ?? a.id) }));
}

async function delegateTask(agent: string, prompt: string, context?: ToolContext): Promise<string> {
  const wanted = fold(agent);
  const text = prompt.trim();
  if (!wanted) return "No agent given. Pass the agent's name or id.";
  if (!text) return "No prompt given. Write the task for the other agent as the user would.";

  let agents: AgentSummary[];
  try {
    agents = await listAgents();
  } catch (e: any) {
    return `Could not reach the HydraOps API to look up agents: ${e?.message || e}`;
  }
  const target = agents.find((a) => fold(a.id) === wanted || fold(a.name) === wanted);
  if (!target) {
    return `No agent called "${agent}". Available agents: ${agents.map((a) => a.name).join(", ")}.`;
  }
  if (context?.agentId && fold(context.agentId) === fold(target.id)) {
    return "That is you. Do the task yourself instead of delegating it.";
  }

  // The other agent sees who asked, so it can answer in the right frame.
  const from = context?.agentId ? agents.find((a) => fold(a.id) === fold(context.agentId!))?.name ?? context.agentId : null;
  const delegated = from ? `${text}\n\n(Task delegated by ${from} on behalf of the user.)` : text;

  try {
    const res = await fetch(`${apiUrl()}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // isRead:false — like Telegram-originated tasks, the target agent shows
      // unread activity until the user opens its chat.
      body: JSON.stringify({ prompt: delegated, channel: target.id, isRead: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return `Could not create the task for ${target.name}${data?.error ? `: ${data.error}` : "."}`;
    return `Task created for ${target.name} (id ${data?.taskId ?? "?"}). ${target.name} will work on it independently; the result appears in ${target.name}'s chat, not here. Tell the user exactly that — do not describe a result you have not seen.`;
  } catch (e: any) {
    return `Could not create the task for ${target.name}: ${e?.message || e}`;
  }
}

export const delegateTaskTool: HydraTool = {
  name: "delegate_task",
  title: "Delegate",
  description:
    "Hand a task to another HydraOps agent by name (e.g. Luna for images, Valentina for video, Sofia for code). Creates the task in that agent's chat; the agent works on it on its own and the reply appears THERE, not in this conversation. Use it when the user asks you to have another agent do something, or when the work clearly belongs to another agent. Write the prompt self-contained, as the user would, with everything the other agent needs. Returns a confirmation only — never the result.",
  schema: z.object({
    agent: z.string().describe("Name or id of the agent to delegate to (e.g. \"Luna\")."),
    prompt: z.string().describe("The task for that agent, complete and self-contained, in the user's language."),
  }),
  execute: async ({ agent, prompt }, context) => await delegateTask(String(agent ?? ""), String(prompt ?? ""), context),
};

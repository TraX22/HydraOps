/**
 * /plan: the agent thinks first and the user decides.
 *
 * A task in plan mode runs with read-only tools only (registry.readOnlyToolNames: no
 * sending, saving, delegating, creating, generating) and one extra tool, propose_plan,
 * through which the model hands back a structured plan: goal, numbered steps with the
 * tools each one needs, open questions. The worker stores it on the task (tasks.plan)
 * and in the reply's resultMeta; the chat shows it as a card with Approve / Edit /
 * Discard and "Ask for a revision", Telegram as a message with buttons.
 *
 * Approving creates a normal task that carries the plan out (renderPlanText). A
 * revision creates another plan-mode task with the previous version and the user's
 * notes; the model returns the next version with each step marked added / changed /
 * removed and a note on what the change implies.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { HydraTool } from './types.js';

export type PlanStatus = 'pending' | 'approved' | 'discarded' | 'superseded';

export interface PlanStep {
  title: string;
  detail?: string;
  /** Tool names the step needs (as the model expects to call them). */
  tools?: string[];
  /** Another agent the step is delegated to. */
  agent?: string;
  /** Revision only: how this step differs from the previous version. */
  change?: 'added' | 'changed' | 'removed';
}

export interface Plan {
  version: number;
  status: PlanStatus;
  goal: string;
  steps: PlanStep[];
  questions: string[];
  /** Revision only: what the user's change implies for the rest of the plan. */
  implications?: string;
  /** The user's request that started the chain (kept on every version). */
  request: string;
  /** Plan-mode task this version revises. */
  parentTaskId?: string;
  /** Task that carries the approved plan out. */
  executionTaskId?: string;
  /** The text the user approved (edited by hand, or renderPlanText of this version). */
  approvedText?: string;
  decidedAt?: string;
  /** Telegram: when the notice with buttons was sent. */
  notifiedAt?: string;
}

export const PLAN_LIMITS = { maxSteps: 25, maxQuestions: 6, maxText: 600, maxTools: 8 };

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const proposePlanSchema = z.object({
  goal: z.string().describe('One sentence: what the finished task delivers.'),
  steps: z.array(z.object({
    title: z.string().describe('The step, as one short line.'),
    detail: z.string().optional().describe('Optional: how, in one or two lines.'),
    tools: z.array(z.string()).optional().describe('Tools this step will use, by their exact names (e.g. web_search, fetch_url, generate_video, delegate_task).'),
    agent: z.string().optional().describe('If the step is delegated to another agent, its id.'),
    change: z.enum(['added', 'changed', 'removed']).optional().describe('Revisions only: how this step differs from the previous version.'),
  })).min(1).max(PLAN_LIMITS.maxSteps),
  questions: z.array(z.string()).max(PLAN_LIMITS.maxQuestions).optional().describe('Things to settle with the user before starting, if any. Only real doubts.'),
  implications: z.string().optional().describe("Revisions only: in two or three lines, what the user's change implies for the rest of the plan (steps that become unnecessary, new ones, risks)."),
});

/** Shapes and clips what the model sent into a Plan. */
export function planFromProposal(raw: unknown, base: { version: number; request: string; parentTaskId?: string }): Plan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const steps: PlanStep[] = (Array.isArray(r.steps) ? r.steps : []).slice(0, PLAN_LIMITS.maxSteps).map((st: any) => {
    const step: PlanStep = { title: clip(st?.title, PLAN_LIMITS.maxText) || '…' };
    if (st?.detail) step.detail = clip(st.detail, PLAN_LIMITS.maxText);
    const tools = Array.isArray(st?.tools) ? st.tools.map((t: unknown) => clip(t, 60)).filter(Boolean).slice(0, PLAN_LIMITS.maxTools) : [];
    if (tools.length) step.tools = tools;
    if (st?.agent) step.agent = clip(st.agent, 60);
    if (st?.change === 'added' || st?.change === 'changed' || st?.change === 'removed') step.change = st.change;
    return step;
  });
  return {
    version: base.version,
    status: 'pending',
    goal: clip(r.goal, PLAN_LIMITS.maxText),
    steps,
    questions: (Array.isArray(r.questions) ? r.questions : []).map((q: unknown) => clip(q, PLAN_LIMITS.maxText)).filter(Boolean).slice(0, PLAN_LIMITS.maxQuestions),
    ...(r.implications ? { implications: clip(r.implications, PLAN_LIMITS.maxText * 2) } : {}),
    request: base.request,
    ...(base.parentTaskId ? { parentTaskId: base.parentTaskId } : {}),
  };
}

/**
 * Fallback when the model wrote the plan as text instead of calling propose_plan:
 * numbered lines become steps. Returns null when there are none.
 */
export function planFromText(text: string, base: { version: number; request: string; parentTaskId?: string }): Plan | null {
  const steps: PlanStep[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.{3,})$/.exec(line);
    if (m && /^\d/.test(line.trim())) steps.push({ title: clip(m[1].replace(/\*\*/g, ''), PLAN_LIMITS.maxText) });
  }
  if (steps.length < 2) return null;
  return { version: base.version, status: 'pending', goal: clip(base.request, PLAN_LIMITS.maxText), steps: steps.slice(0, PLAN_LIMITS.maxSteps), questions: [], request: base.request, ...(base.parentTaskId ? { parentTaskId: base.parentTaskId } : {}) };
}

/** The plan as Markdown: for Telegram, for the Edit box, and for the task that carries it out. */
export function renderPlanText(plan: Plan): string {
  const lines: string[] = [];
  if (plan.goal) lines.push(`Goal: ${plan.goal}`, '');
  plan.steps.forEach((st, i) => {
    if (st.change === 'removed') return;
    const extras: string[] = [];
    if (st.agent) extras.push(`→ ${st.agent}`);
    if (st.tools?.length) extras.push(st.tools.join(', '));
    lines.push(`${i + 1}. ${st.title}${extras.length ? ` (${extras.join(' · ')})` : ''}`);
    if (st.detail) lines.push(`   ${st.detail}`);
  });
  if (plan.questions.length) {
    lines.push('', 'Open questions:');
    for (const q of plan.questions) lines.push(`- ${q}`);
  }
  return lines.join('\n').trim();
}

/** What the execution task receives as its prompt. */
export function executionPrompt(plan: Plan, approvedText?: string): string {
  const text = (approvedText ?? renderPlanText(plan)).trim();
  return `${plan.request}\n\n[APPROVED PLAN — the user reviewed and approved these steps; follow them in order, adapting only if a step turns out impossible, and say so]\n${text}`;
}

/** The system-prompt block of a plan-mode task. */
export function planModePrompt(opts: { toolNames: string[]; previous?: Plan; userNotes?: string; version: number }): string {
  const lines = [
    '',
    '---',
    '[PLAN MODE]',
    'This task is a PLAN, not the work itself. The user wants to see and approve how you would do it before anything happens. In this mode you only have tools that read (' + (opts.toolNames.length ? opts.toolNames.join(', ') : 'none') + '); nothing that sends, saves, delegates, creates or generates is available now, and you must not pretend to do those.',
    'Use the reading tools only as far as needed to make a realistic plan (check what exists, what a page offers), not to do the whole task.',
    'Then call propose_plan ONCE with: the goal in one sentence; 3–12 concrete steps in order, each with the exact tool names it will use (including the ones you do not have now, e.g. send_to_telegram, remember, create_skill, delegate_task, generate_image, generate_video, github_create_issue) and the agent id when a step is delegated; and open questions only for real doubts that change the plan.',
    'After the tool call, write ONE short paragraph for the user (what you looked at and the main choice you made). Do not repeat the steps in the text: the app shows the plan itself.',
  ];
  if (opts.previous) {
    lines.push(
      '',
      `This is REVISION v${opts.version} of the plan below (v${opts.previous.version}). The user changed or annotated it:`,
      '<<<PREVIOUS PLAN',
      renderPlanText(opts.previous),
      '>>>',
      '<<<USER NOTES',
      (opts.userNotes ?? '').trim() || '(no notes)',
      '>>>',
      'Keep what still holds. In propose_plan mark each step with change: "added", "changed" or "removed" (keep removed steps in the list, marked, so the user sees them go), leave unchanged steps unmarked, and fill `implications` with what the change means for the rest (steps that become unnecessary, new needs, risks). Ask in `questions` if the notes leave something open.',
    );
  }
  return lines.join('\n');
}

export const PLAN_TOOL_DESCRIPTION =
  'Hand the user your plan for this task (plan mode). Call it once, when you know enough: goal, ordered steps with the exact tools each one uses (also the ones you cannot use now) and the agent a step is delegated to, and open questions if any.';

/**
 * The propose_plan tool a plan-mode task gets on top of its read-only tools, in both
 * shapes the workers pass to the LLM package (AI SDK tools and raw tools). `onProposal`
 * receives what the model sent; the worker turns it into a Plan with planFromProposal.
 */
export function createPlanTools(onProposal: (proposal: unknown) => void): { ai: Record<string, any>; raw: HydraTool[] } {
  const execute = async (args: unknown) => {
    onProposal(args);
    return 'Plan received. Now write one short paragraph for the user (what you looked at, the main choice); the app shows the plan itself. Do not call propose_plan again.';
  };
  return {
    ai: { propose_plan: tool({ description: PLAN_TOOL_DESCRIPTION, inputSchema: proposePlanSchema, execute }) },
    raw: [{ name: 'propose_plan', description: PLAN_TOOL_DESCRIPTION, schema: proposePlanSchema, execute, source: 'native', risk: {} }],
  };
}

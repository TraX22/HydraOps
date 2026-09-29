/**
 * Prompt-injection defense, part 2: running a held call once the user approved it.
 *
 * The call is replayed exactly as the model issued it — same tool, same arguments —
 * through the same per-agent gate and security guard as any tool call, but WITHOUT
 * the model: the approval is a decision on that one call, not a new turn in which
 * the model (and whatever outside content it read) could change its mind.
 */
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';
import { redactSecrets } from './guard.js';
import { wrapExternalContent } from './provenance.js';

export interface ApprovedCall {
  toolName: string;
  args: unknown;
  /** Bullet lines of the agent's tools.md: the gate is the same as for a live task. */
  requestedTools: string[];
  nativeState: Record<string, boolean>;
  context: ToolContext;
  /** A worker's own tool (generate_video) is not in the registry; the worker runs it here. */
  runOwnTool?: (toolName: string, args: any) => Promise<string> | undefined;
}

export interface ApprovedCallResult {
  ok: boolean;
  /** What the tool returned (or the reason it did not run), redacted and capped. */
  result: string;
}

const MAX_RESULT = 2000;
const clean = (s: unknown) => redactSecrets(String(s ?? '')).slice(0, MAX_RESULT);

export async function executeApprovedCall(registry: ToolRegistry, call: ApprovedCall): Promise<ApprovedCallResult> {
  const own = call.runOwnTool?.(call.toolName, call.args);
  if (own) {
    try { return { ok: true, result: clean(await own) }; }
    catch (err: any) { return { ok: false, result: clean(err?.message ?? err) }; }
  }
  const allowed = registry.resolveAllowedToolNames(call.requestedTools);
  if (!allowed.includes(call.toolName)) {
    return { ok: false, result: `The agent no longer has the ${call.toolName} tool.` };
  }
  // No security state: the user's approval IS the decision. guardTool still applies.
  const tool = registry.getRawTools([call.toolName], call.nativeState, undefined, call.context).find((t) => t.name === call.toolName);
  if (!tool) return { ok: false, result: `${call.toolName} is switched off or not available right now.` };
  try {
    const result = await tool.execute(call.args);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const blocked = text.startsWith('⛔ Blocked by HydraOps security guard');
    return { ok: !blocked, result: clean(text) };
  } catch (err: any) {
    return { ok: false, result: clean(err?.message ?? err) };
  }
}

// ── Continuing after the decision ─────────────────────────────────────────────
// A task that asked for approval ends its turn; once every held call is decided, the
// worker starts a follow-up task in the same chat (see @hydraops/db
// createContinuationTask) and composes this message for it: what the user decided and
// what each call returned, so the agent carries on instead of asking again.

export interface DecidedAction {
  toolName: string;
  args: unknown;
  /** executed | failed | rejected | expired */
  status: string;
  result?: string | null;
}

const MAX_ARGS_CHARS = 400;
const describeArgs = (args: unknown): string => {
  try { return redactSecrets(JSON.stringify(args ?? {})).slice(0, MAX_ARGS_CHARS); } catch { return '{}'; }
};

/** The user message of a continuation task. */
export function continuationPrompt(originalPrompt: string, actions: DecidedAction[]): string {
  const lines = actions.map((a) => {
    const head = `- ${a.toolName}(${describeArgs(a.args)})`;
    if (a.status === 'executed') return `${head} → APPROVED and run. It returned:\n${wrapExternalContent(a.result ?? '(no output)', a.toolName, 'approved-' + a.toolName)}`;
    if (a.status === 'failed') return `${head} → APPROVED, but it failed:\n${wrapExternalContent(a.result ?? '(no details)', a.toolName, 'approved-' + a.toolName)}`;
    if (a.status === 'rejected') return `${head} → REJECTED by the user. Do not retry it; adjust or explain.`;
    return `${head} → not decided in time (expired). Ask again only if it is still needed.`;
  });
  return (
    `[APPROVAL OUTCOME] In your previous turn you asked the user to approve one or more calls. They have been decided:\n` +
    `${lines.join('\n')}\n\n` +
    `Continue the task from where you left off using these outcomes; do not repeat the calls that ran. ` +
    `The request you were working on: "${originalPrompt.replace(/\s+/g, ' ').trim().slice(0, 600)}"`
  );
}

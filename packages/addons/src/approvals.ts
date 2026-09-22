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

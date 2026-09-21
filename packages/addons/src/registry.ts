import { tool } from 'ai';
import { HydraTool, ToolContext, ToolKeyRequirement } from './types.js';
import { McpClientManager, McpServerStatus } from './mcp.js';
import { guardTool } from './guard.js';
import { extractSources, type ToolSourceSink } from './sources.js';
import { resolveToolRisk, type TaskSecurity, type ToolRisk } from './provenance.js';

/**
 * Called once per tool invocation for usage tracking. `source` is native |
 * my_addons | mcp; `status` is ok | blocked (by the security guard) | error.
 * Wired by the workers so we can record what each agent actually uses.
 */
export type ToolUsageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error') => void;

/**
 * Wraps an already-guarded tool so every call is reported to the sink, without
 * touching the security layer. It sits OUTSIDE guardTool: a guard block returns
 * the ⛔ marker string (→ 'blocked'), a thrown error → 'error', anything else →
 * 'ok'. Tracking is best-effort and must never change what the model receives.
 *
 * The one thing that does change the result is `security` (see provenance.ts): a
 * tool that reads third-party content marks the task as tainted and hands its
 * result to the model wrapped in "data, not instructions" markers.
 */
function instrumentTool(t: HydraTool, source: string, sink?: ToolUsageSink, sourceSink?: ToolSourceSink, security?: TaskSecurity): HydraTool {
  return {
    ...t,
    execute: async (args: any) => {
      const risk = resolveToolRisk(t, source, args);
      try {
        security?.beforeCall(t.name, risk, args);
        const result = await t.execute(args);
        const blocked = typeof result === 'string' && result.startsWith('⛔ Blocked by HydraOps security guard');
        try { sink?.(t.name, source, blocked ? 'blocked' : 'ok'); } catch { /* tracking never breaks a call */ }
        // Which addresses did this call open or surface? (see sources.ts)
        if (sourceSink && !blocked) {
          try { const found = extractSources(t.name, args, result); if (found.length) sourceSink(found); } catch { /* best-effort */ }
        }
        // Last, so usage and sources above still see the tool's own output.
        return security ? security.afterCall(t.name, risk, args, result) : result;
      } catch (err) {
        try { sink?.(t.name, source, 'error'); } catch { /* ignore */ }
        throw err;
      }
    },
  };
}

export class ToolRegistry {
  private nativeTools = new Map<string, HydraTool>();
  public mcpManager = new McpClientManager();

  async initializeMcp(mcpConfig: any) {
    await this.mcpManager.connectServers(mcpConfig);
  }

  registerNative(t: HydraTool) {
    this.nativeTools.set(t.name, t);
  }

  // Names of every registered native/my_addons tool (for building allow-lists)
  getNativeToolNames(): string[] {
    return [...this.nativeTools.keys()];
  }

  /**
   * Strict per-agent tool gating. An agent gets a tool (native, my_addons or MCP)
   * ONLY if its tools.md names it — either the exact tool name, or a group/server
   * prefix (e.g. `github` enables every `github_*` tool; an MCP server name
   * enables its tools). An empty/prose-only tools.md grants nothing. This is the
   * single source of truth used by every worker, so the rule is identical
   * regardless of worker type.
   *
   * `requested` are the bullet lines from the agent's tools.md.
   * `enabledMcpServers` (from the chat UI) further NARROWS which MCP servers may
   * run this turn — a tool must be BOTH named in tools.md AND, when that list is
   * non-empty, belong to an enabled server.
   */
  resolveAllowedToolNames(requested: string[], enabledMcpServers: string[] = []): string[] {
    const norm = requested.map((r) => r.replace(/\s+/g, "_").toLowerCase()).filter(Boolean);
    const named = (toolName: string) => norm.some((c) => toolName === c || toolName.startsWith(c + "_"));

    const allowed: string[] = [];
    for (const name of this.nativeTools.keys()) {
      if (named(name)) allowed.push(name);
    }
    for (const t of this.mcpManager.mcpTools.keys()) {
      if (!named(t)) continue;
      if (enabledMcpServers.length > 0) {
        const onEnabledServer = enabledMcpServers.some((s) => t.startsWith(s.replace(/\s+/g, "_").toLowerCase() + "_"));
        if (!onEnabledServer) continue;
      }
      allowed.push(t);
    }
    return allowed;
  }

  // Metadata for the UI (no schema/execute)
  listNative(): { name: string; title?: string; description: string; source: string; requiresKey?: ToolKeyRequirement; risk: ToolRisk }[] {
    return [...this.nativeTools.values()].map(t => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      source: t.source ?? 'native',
      ...(t.requiresKey ? { requiresKey: t.requiresKey } : {}),
      risk: resolveToolRisk(t, t.source ?? 'native'),
    }));
  }

  // Obtains the raw HydraTools (useful for local fallback logic). An optional
  // usage sink reports every invocation (tool + source + status) for tracking.
  // `context` (e.g. the calling agent's id) is bound INSIDE the guard/tracking
  // wrappers, so it reaches the tool untouched and callers never pass it per call.
  // `security` is the task's prompt-injection state (see provenance.ts); pass the
  // SAME object to getRawTools and getAiSdkTools so both views share one taint.
  getRawTools(allowedNames: string[], globalNativeState: Record<string, boolean>, sink?: ToolUsageSink, context?: ToolContext, sourceSink?: ToolSourceSink, security?: TaskSecurity): HydraTool[] {
    const activeTools: HydraTool[] = [];

    const bind = (t: HydraTool): HydraTool =>
      context ? { ...t, execute: (args: any) => t.execute(args, context) } : t;
    const finalize = (t: HydraTool, source: string) => {
      const bound = bind(t);
      return sink || sourceSink || security ? instrumentTool(guardTool(bound), source, sink, sourceSink, security) : guardTool(bound);
    };

    for (const name of allowedNames) {
      const nt = this.nativeTools.get(name);
      // Natives are returned only when not switched off globally. guardTool()
      // wraps EVERY tool (native or MCP) with the hard blocklist and the secret
      // redaction — this is the single exit point.
      if (nt && globalNativeState[name] !== false) {
        activeTools.push(finalize(nt, nt.source === 'my_addons' ? 'my_addons' : 'native'));
      }

      // MCP tools
      const mt = this.mcpManager.mcpTools.get(name);
      if (mt) {
        activeTools.push(finalize(mt, 'mcp'));
      }
    }

    return activeTools;
  }

  // Returns the tools in the shape the Vercel AI SDK expects
  getAiSdkTools(allowedNames: string[], globalNativeState: Record<string, boolean>, sink?: ToolUsageSink, context?: ToolContext, sourceSink?: ToolSourceSink, security?: TaskSecurity) {
    const rawTools = this.getRawTools(allowedNames, globalNativeState, sink, context, sourceSink, security);
    if (rawTools.length === 0) return undefined;
    
    const aiTools: Record<string, any> = {};
    for (const rt of rawTools) {
      aiTools[rt.name] = tool({
        description: rt.description,
        // AI SDK v5+ renamed `parameters` → `inputSchema`; with the old key the
        // schema is silently dropped and tools go out as {properties:{}}.
        inputSchema: rt.schema,
        execute: rt.execute
      });
    }
    return aiTools;
  }

  /**
   * Returns the connection status of all MCP servers
   */
  getServerStatuses(): McpServerStatus[] {
    return this.mcpManager.getStatuses();
  }
}

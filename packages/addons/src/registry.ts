import { harvestMediaFiles } from './harvest-files.js';
import { tool } from 'ai';
import { HydraTool, ToolContext, ToolKeyRequirement } from './types.js';
import { McpClientManager, McpServerStatus } from './mcp.js';
import { guardTool } from './guard.js';
import { extractSources, extractSeenUrls, contentDigest, type ToolSourceSink } from './sources.js';
import { resolveToolRisk, type TaskSecurity, type ToolRisk } from './provenance.js';
import type { ToolProgressSink } from './progress.js';
import { createVaultTools, type TaskVault } from './vault.js';

/**
 * Called once per tool invocation for usage tracking. `source` is native |
 * my_addons | mcp; `status` is ok | blocked (by the security guard) | error.
 * Wired by the workers so we can record what each agent actually uses.
 */
export type ToolUsageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error' | 'held', args?: unknown) => void;

/**
 * Wraps an already-guarded tool so every call is reported to the sink, without
 * touching the security layer. It sits OUTSIDE guardTool: a guard block returns
 * the ⛔ marker string (→ 'blocked'), a thrown error → 'error', anything else →
 * 'ok'. Tracking is best-effort and must never change what the model receives.
 *
 * Two things do change the result. `vault` (see vault.ts) keeps a long result whole
 * on disk and hands the model a digest of it; without a vault a long result is cut
 * at NO_VAULT_CAP, the old behaviour. `security` (see provenance.ts): a tool that
 * reads third-party content marks the task as tainted and hands its result to the
 * model wrapped in "data, not instructions" markers.
 */
const NO_VAULT_CAP = 8_000;

function instrumentTool(t: HydraTool, source: string, sink?: ToolUsageSink, sourceSink?: ToolSourceSink, security?: TaskSecurity, progress?: ToolProgressSink, vault?: TaskVault): HydraTool {
  return {
    ...t,
    execute: async (args: any) => {
      const risk = resolveToolRisk(t, source, args);
      // A sensitive call on a task that read outside content is not run: it is stored
      // for the user's approval and the model gets an explanation instead.
      if (security?.shouldHold(t.name, risk)) {
        try { progress?.('held', t.name, args); } catch { /* progress never breaks a call */ }
        const message = await security.hold(t.name, args);
        try { sink?.(t.name, source, 'held'); } catch { /* tracking never breaks a call */ }
        return message;
      }
      try { progress?.('start', t.name, args); } catch { /* progress never breaks a call */ }
      try {
        security?.beforeCall(t.name, risk, args);
        const result = await t.execute(args);
        const blocked = typeof result === 'string' && result.startsWith('⛔ Blocked by HydraOps security guard');
        try { sink?.(t.name, source, blocked ? 'blocked' : 'ok', args); } catch { /* tracking never breaks a call */ }
        // Which addresses did this call open or surface? (see sources.ts)
        if (sourceSink && !blocked) {
          try {
            const found = extractSources(t.name, args, result);
            // One page read by this call: remember what it said, as a digest.
            const reads = found.filter((s) => s.kind === 'read');
            if (reads.length === 1 && typeof result === 'string' && result.length > 0) reads[0].digest = contentDigest(result);
            const seen = extractSeenUrls(result);
            if (found.length || seen.length) sourceSink(found, seen);
          } catch { /* best-effort */ }
        }
        // Last, so usage and sources above still see the tool's own output.
        const shown = blocked || t.vault === false ? result : vault ? await vault.store(t.name, args, result, { external: risk.readsExternal === true }) : capWithoutVault(result);
        return security ? security.afterCall(t.name, risk, args, shown) : shown;
      } catch (err) {
        try { sink?.(t.name, source, 'error'); } catch { /* ignore */ }
        throw err;
      } finally {
        try { progress?.('end', t.name); } catch { /* progress never breaks a call */ }
      }
    },
  };
}

function capWithoutVault(result: unknown): unknown {
  if (typeof result !== 'string' || result.length <= NO_VAULT_CAP) return result;
  return result.slice(0, NO_VAULT_CAP) + `\n[result cut at ${NO_VAULT_CAP} characters]`;
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

  /**
   * Plan mode: of the tools an agent may use, those that only read. A tool is left out
   * when its risk says sensitive (send, save, delegate, create, generate…) or it always
   * asks for approval; an unknown MCP tool counts as sensitive (worst case, as in
   * provenance.ts), so it is left out too.
   */
  readOnlyToolNames(allowedNames: string[]): string[] {
    return allowedNames.filter((name) => {
      const t = this.nativeTools.get(name) ?? this.mcpManager.mcpTools.get(name);
      if (!t) return false;
      const source = this.nativeTools.has(name) ? (t.source === 'my_addons' ? 'my_addons' : 'native') : 'mcp';
      const risk = resolveToolRisk(t, source);
      return risk.sensitive !== true && risk.approval !== 'always';
    });
  }

  /** What tools-on-demand.ts needs to build the index: the tool maps and who owns each MCP tool. */
  indexSources(): { nativeTools: Map<string, HydraTool>; mcpTools: Map<string, HydraTool>; serverOfTool: (name: string) => string | undefined } {
    return { nativeTools: this.nativeTools, mcpTools: this.mcpManager.mcpTools, serverOfTool: (n) => this.mcpManager.serverOfTool(n) };
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
  // `vault` (see vault.ts) keeps long results whole; when given, the model also gets
  // the vault_read / vault_find tools, instrumented like the rest.
  getRawTools(allowedNames: string[], globalNativeState: Record<string, boolean>, sink?: ToolUsageSink, context?: ToolContext, sourceSink?: ToolSourceSink, security?: TaskSecurity, progress?: ToolProgressSink, vault?: TaskVault): HydraTool[] {
    const activeTools: HydraTool[] = [];

    const bind = (t: HydraTool): HydraTool =>
      context ? { ...t, execute: (args: any) => t.execute(args, context) } : t;
    // Every tool leaves through instrumentTool, even with no sinks: it is where a long
    // result is capped (or vaulted) — the single exit point for size as well.
    const finalize = (t: HydraTool, source: string) =>
      instrumentTool(guardTool(bind(t)), source, sink, sourceSink, security, progress, vault);

    for (const name of allowedNames) {
      const nt = this.nativeTools.get(name);
      // Natives are returned only when not switched off globally. guardTool()
      // wraps EVERY tool (native or MCP) with the hard blocklist and the secret
      // redaction — this is the single exit point.
      if (nt && globalNativeState[name] !== false) {
        activeTools.push(finalize(nt, nt.source === 'my_addons' ? 'my_addons' : 'native'));
      }

      // MCP tools. Media a connection's tool names in its answer (a saved image's path, a
      // /view address on this computer) is brought into the task so the chat shows it.
      const mt = this.mcpManager.mcpTools.get(name);
      if (mt) {
        const harvesting: HydraTool = context?.addResultFile
          ? { ...mt, execute: async (args: any, ctx?: ToolContext) => { const r = await mt.execute(args, ctx); await harvestMediaFiles(r, ctx ?? context); return r; } }
          : mt;
        activeTools.push(finalize(harvesting, 'mcp'));
      }
    }
    if (vault && activeTools.length) {
      for (const vt of createVaultTools(vault)) activeTools.push(finalize(vt, 'native'));
    }

    return activeTools;
  }

  // Returns the tools in the shape the Vercel AI SDK expects
  getAiSdkTools(allowedNames: string[], globalNativeState: Record<string, boolean>, sink?: ToolUsageSink, context?: ToolContext, sourceSink?: ToolSourceSink, security?: TaskSecurity, progress?: ToolProgressSink, vault?: TaskVault) {
    const rawTools = this.getRawTools(allowedNames, globalNativeState, sink, context, sourceSink, security, progress, vault);
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

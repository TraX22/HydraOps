import { tool } from 'ai';
import { HydraTool, ToolKeyRequirement } from './types.js';
import { McpClientManager, McpServerStatus } from './mcp.js';
import { guardTool } from './guard.js';

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
  listNative(): { name: string; description: string; source: string; requiresKey?: ToolKeyRequirement }[] {
    return [...this.nativeTools.values()].map(t => ({
      name: t.name,
      description: t.description,
      source: t.source ?? 'native',
      ...(t.requiresKey ? { requiresKey: t.requiresKey } : {}),
    }));
  }

  // Obtains the raw HydraTools (useful for local fallback logic)
  getRawTools(allowedNames: string[], globalNativeState: Record<string, boolean>): HydraTool[] {
    const activeTools: HydraTool[] = [];
    
    for (const name of allowedNames) {
      const nt = this.nativeTools.get(name);
      // Solo devolvemos nativas si no están desactivadas globalmente.
      // guardTool() envuelve TODA tool (nativa o MCP) con la blocklist dura
      // y la redacción de secretos — este es el único punto de salida.
      if (nt && globalNativeState[name] !== false) {
        activeTools.push(guardTool(nt));
      }

      // Herramientas MCP
      const mt = this.mcpManager.mcpTools.get(name);
      if (mt) {
        activeTools.push(guardTool(mt));
      }
    }
    
    return activeTools;
  }

  // Devuelve el objeto formateado para Vercel AI SDK
  getAiSdkTools(allowedNames: string[], globalNativeState: Record<string, boolean>) {
    const rawTools = this.getRawTools(allowedNames, globalNativeState);
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

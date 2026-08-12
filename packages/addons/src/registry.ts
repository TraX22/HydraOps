import { tool } from 'ai';
import { HydraTool } from './types.js';
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

  // Metadata for the UI (no schema/execute)
  listNative(): { name: string; description: string; source: string }[] {
    return [...this.nativeTools.values()].map(t => ({
      name: t.name,
      description: t.description,
      source: t.source ?? 'native',
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

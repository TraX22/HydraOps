import { myAddonsDir } from '@hydraops/config';
import { ToolRegistry } from './registry.js';
import { loadDirectoryAddons } from './loader.js';
import { webSearchTool } from './native/web_search/index.js';
import { braveSearchTool } from './native/brave_search/index.js';
import { fetchUrlTool } from './native/fetch_url/index.js';
import { youtubeTranscriptTool } from './native/youtube_transcript/index.js';
import { githubTools } from './native/github/index.js';
import { sendToTelegramTool } from './native/send_to_telegram/index.js';
import { rememberTool } from './native/remember/index.js';
export * from './types.js';
export { ToolRegistry };
export { guardTool, checkToolArgs, redactSecrets, assertPublicUrl } from './guard.js';
export type { McpServerState, McpServerStatus } from './mcp.js';

// User addons live in <dataRoot>/my_addons/<name>/index.ts, each exporting a
// HydraTool. Override the location with MY_ADDONS_DIR.
export async function createRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  registry.registerNative({ ...webSearchTool, source: 'native' });
  registry.registerNative({ ...braveSearchTool, source: 'native' });
  registry.registerNative({ ...fetchUrlTool, source: 'native' });
  registry.registerNative({ ...youtubeTranscriptTool, source: 'native' });
  registry.registerNative({ ...sendToTelegramTool, source: 'native' });
  registry.registerNative({ ...rememberTool, source: 'native' });
  for (const t of githubTools) registry.registerNative({ ...t, source: 'native' });

  const dir = process.env.MY_ADDONS_DIR ?? myAddonsDir;
  await loadDirectoryAddons(dir, 'my_addons', registry);

  return registry;
}

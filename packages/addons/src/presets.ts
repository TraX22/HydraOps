/**
 * Connection presets: ready-made MCP server entries from the catalog (the public
 * HydraOps-Skills repository, `presets/<name>/preset.json`).
 *
 * A preset is configuration, not code: how to start a server somebody else publishes
 * (through uvx, npx or docker, or a remote URL), what it needs on this computer, and —
 * the part only a person who read the server can write — what each of its tools does
 * (`toolRisk`, see provenance.ts). Installing one writes an entry in the MCP config;
 * nothing of HydraOps is downloaded or run. The program's version is pinned inside the
 * preset, so it changes only when the user updates the preset.
 */
import { createHash } from 'node:crypto';
import { isMcpToolClass, type McpToolClass } from './provenance.js';

/** What may start a catalog server. Anything else in `server.command` is refused. */
export const PRESET_LAUNCHERS = ['uvx', 'npx', 'docker'] as const;
export type PresetLauncher = (typeof PRESET_LAUNCHERS)[number] | 'none';

export interface ConnectionPreset {
  name: string;
  /** Display name and the key of the MCP entry (its tools get this prefix, lower-cased). */
  title: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  server: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
  requires: { launcher: PresetLauncher; notes: string[]; setup: { run?: string; then?: string }[] };
  toolRisk: Record<string, McpToolClass>;
  /** The line an agent's tools.md needs to get every tool of this connection. */
  toolsMd: string;
  tips: string[];
}

/** The marker an installed entry carries, to know where it came from and whether it was edited. */
export interface PresetMarker { name: string; version: string; hash: string }

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOOL_RE = /^[A-Za-z0-9_.-]{1,80}$/;
// No control characters, and nothing a shell would treat specially: arguments are passed
// as an array (no shell), this only keeps a catalog entry from looking like a command line.
const SAFE_ARG_RE = /^[^\x00-\x1f\x7f`$|&<>]{1,300}$/;

export const isValidPresetName = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && NAME_RE.test(v);
const normServer = (v: string) => v.replace(/\s+/g, '_').toLowerCase();
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);

/** Validates a preset.json. Strict on what ends up in the MCP config, lenient on the prose. */
export function parsePreset(raw: unknown): { preset: ConnectionPreset } | { error: string } {
  const p = raw as any;
  if (!p || typeof p !== 'object') return { error: 'not an object' };
  if (!isValidPresetName(p.name)) return { error: 'invalid name' };
  if (typeof p.title !== 'string' || !TITLE_RE.test(p.title)) return { error: 'invalid title' };
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) return { error: 'invalid version' };
  const description = str(p.description, 500);
  if (!description) return { error: 'description is missing' };

  const srv = p.server;
  if (!srv || typeof srv !== 'object') return { error: 'server is missing' };
  const server: ConnectionPreset['server'] = {};
  let launcher: PresetLauncher;
  if (typeof srv.command === 'string') {
    if (!(PRESET_LAUNCHERS as readonly string[]).includes(srv.command)) return { error: `launcher "${srv.command}" is not allowed` };
    if (!Array.isArray(srv.args) || srv.args.length === 0 || srv.args.length > 24) return { error: 'server.args must be a list' };
    if (!srv.args.every((a: unknown) => typeof a === 'string' && SAFE_ARG_RE.test(a))) return { error: 'server.args has an unsafe value' };
    server.command = srv.command;
    server.args = [...srv.args];
    launcher = srv.command as PresetLauncher;
  } else if (typeof srv.url === 'string') {
    let u: URL;
    try { u = new URL(srv.url); } catch { return { error: 'server.url is not a URL' }; }
    if (u.protocol !== 'https:') return { error: 'server.url must be https' };
    server.url = u.href;
    launcher = 'none';
  } else {
    return { error: 'server needs a command or a url' };
  }
  if (srv.env !== undefined) {
    if (!srv.env || typeof srv.env !== 'object' || Array.isArray(srv.env)) return { error: 'server.env must be a map' };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(srv.env).slice(0, 24)) {
      if (!ENV_KEY_RE.test(k) || typeof v !== 'string' || !SAFE_ARG_RE.test(v)) return { error: `server.env.${k} is not valid` };
      env[k] = v;
    }
    if (Object.keys(env).length) server.env = env;
  }

  const toolRisk: Record<string, McpToolClass> = {};
  if (p.toolRisk !== undefined) {
    if (!p.toolRisk || typeof p.toolRisk !== 'object' || Array.isArray(p.toolRisk)) return { error: 'toolRisk must be a map' };
    const entries = Object.entries(p.toolRisk);
    if (entries.length > 300) return { error: 'toolRisk has too many entries' };
    for (const [tool, cls] of entries) {
      if (!TOOL_RE.test(tool) || !isMcpToolClass(cls)) return { error: `toolRisk.${tool} is not valid` };
      toolRisk[tool] = cls;
    }
  }

  const req = p.requires && typeof p.requires === 'object' ? p.requires : {};
  const setup = (Array.isArray(req.setup) ? req.setup : []).slice(0, 6)
    .map((s: any) => ({ ...(str(s?.run, 200) ? { run: str(s.run, 200) } : {}), ...(str(s?.then, 400) ? { then: str(s.then, 400) } : {}) }))
    .filter((s: { run?: string; then?: string }) => s.run || s.then);

  const homepage = str(p.homepage, 200);
  return {
    preset: {
      name: p.name,
      title: p.title,
      description,
      version: p.version,
      author: str(p.author, 80),
      ...(homepage.startsWith('https://') ? { homepage } : {}),
      server,
      requires: { launcher, notes: strList(req.notes, 6, 300), setup },
      toolRisk,
      // Always derived: the gate matches an agent's line against the server's name.
      toolsMd: normServer(p.title),
      tips: strList(p.tips, 6, 300),
    },
  };
}

/** What identifies an installed entry as "untouched since it was installed" (env and the switch are the user's). */
export function presetEntryHash(entry: any): string {
  const risk = entry?.toolRisk && typeof entry.toolRisk === 'object' ? entry.toolRisk : {};
  const sorted = Object.keys(risk).sort().map((k) => [k, risk[k]]);
  return createHash('sha256').update(JSON.stringify([entry?.command ?? null, entry?.args ?? null, entry?.url ?? null, sorted])).digest('hex');
}

/**
 * The MCP config entry a preset installs. Updating keeps what is the user's in the entry
 * it replaces: the on/off switch and the values of the environment variables the preset
 * still defines (a port, a host).
 */
export function presetServerEntry(preset: ConnectionPreset, previous?: any): Record<string, unknown> {
  const env: Record<string, string> = { ...(preset.server.env ?? {}) };
  const prevEnv = previous?.env && typeof previous.env === 'object' ? previous.env : {};
  for (const k of Object.keys(env)) if (typeof prevEnv[k] === 'string' && prevEnv[k]) env[k] = prevEnv[k];
  const entry: Record<string, unknown> = {
    ...(preset.server.command ? { command: preset.server.command, args: [...(preset.server.args ?? [])] } : { url: preset.server.url }),
    ...(Object.keys(env).length ? { env } : {}),
    switch: previous?.switch === 'off' ? 'off' : 'on',
    toolRisk: { ...preset.toolRisk },
  };
  const marker: PresetMarker = { name: preset.name, version: preset.version, hash: presetEntryHash(entry) };
  return { ...entry, preset: marker };
}

/** The marker of an installed entry, or null for a server the user configured by hand. */
export function presetMarkerOf(entry: any): PresetMarker | null {
  const m = entry?.preset;
  return m && isValidPresetName(m.name) && typeof m.version === 'string' && typeof m.hash === 'string' ? { name: m.name, version: m.version, hash: m.hash } : null;
}

/** True when a catalog entry's command, arguments or classification were edited after installing. */
export function isPresetEntryModified(entry: any): boolean {
  const m = presetMarkerOf(entry);
  return !!m && m.hash !== presetEntryHash(entry);
}

/** How the server is started, for the preview ("uvx mcp-for-blender==2.1.3"). */
export function presetCommandLine(preset: ConnectionPreset): string {
  return preset.server.command ? [preset.server.command, ...(preset.server.args ?? [])].join(' ') : String(preset.server.url ?? '');
}

/** How to get a launcher that is missing. */
export function launcherInstallHint(launcher: PresetLauncher, platform: string = process.platform): { command?: string; url: string } | null {
  if (launcher === 'uvx') {
    return {
      command: platform === 'win32' ? 'winget install astral-sh.uv' : platform === 'darwin' ? 'brew install uv' : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      url: 'https://docs.astral.sh/uv/getting-started/installation/',
    };
  }
  if (launcher === 'npx') return { ...(platform === 'win32' ? { command: 'winget install OpenJS.NodeJS.LTS' } : platform === 'darwin' ? { command: 'brew install node' } : {}), url: 'https://nodejs.org/' };
  if (launcher === 'docker') return { url: 'https://docs.docker.com/get-started/get-docker/' };
  return null;
}

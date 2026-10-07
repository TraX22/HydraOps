/**
 * tools-on-demand.ts — the model gets an index of its tools, not every definition.
 *
 * An agent with a few connections carries 40k+ tokens of tool schemas in EVERY call, even
 * to answer "hi". Above a threshold the full definitions stay out of the call: the model
 * gets a compact index (name and a one-line summary, grouped by connection) plus one tool,
 * `load_tools`, that brings the full definition of the ones it names into the next step.
 * The AI SDK sends only the active tools' schemas (`activeTools` in prepareStep); the
 * tool map stays complete, so execution, approvals and the guard do not change.
 *
 * What is active from the start: `load_tools`, what the same chat used in its previous
 * task, the calls a continuation carries, and any connection or tool named in the
 * user's message. A tool the model calls stays active for the rest of the task.
 */
import { z } from "zod";
import { tool } from "ai";
import type { HydraTool } from "./types.js";

export const LOAD_TOOL_NAME = "load_tools";
/** Below this many tools everything is sent as before: an index would not pay for itself. */
export const ON_DEMAND_MIN_TOOLS = 12;
/** A connection named in the message is preloaded whole only up to this many tools; past it, the model picks. */
export const PRELOAD_GROUP_MAX = 15;
const SUMMARY_MAX = 90;

export interface ToolIndexEntry {
  name: string;
  /** The connection's name, or "Native" / "Add-ons". */
  group: string;
  summary: string;
}

/** The first sentence of a description, without the "[From X]:" prefix, cut at SUMMARY_MAX. */
export function summarize(description: string): string {
  let s = String(description ?? "").replace(/^\[From [^\]]*\]:\s*/i, "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.{12,}?[.!?])(\s|$)/);
  if (m) s = m[1];
  if (s.length > SUMMARY_MAX) s = s.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

export interface IndexSources {
  nativeTools: Map<string, HydraTool>;
  mcpTools: Map<string, HydraTool>;
  serverOfTool: (toolName: string) => string | undefined;
}

/** The index of the tools this task may use, in the order given. */
export function buildToolIndex(src: IndexSources, allowedNames: string[]): ToolIndexEntry[] {
  const out: ToolIndexEntry[] = [];
  for (const name of allowedNames) {
    const nt = src.nativeTools.get(name);
    if (nt) { out.push({ name, group: nt.source === "my_addons" ? "Add-ons" : "Native", summary: summarize(nt.description) }); continue; }
    const mt = src.mcpTools.get(name);
    if (mt) out.push({ name, group: src.serverOfTool(name) ?? "MCP", summary: summarize(mt.description) });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Tools the user's own words point at: a connection whose name (or its first five letters,
 * "comfy", "blend") appears in the message, or a tool named by its own words
 * ("run workflow"). A connection named in the message comes along whole when it is small
 * (PRELOAD_GROUP_MAX); a big one would bring back the very cost this avoids, so there the
 * model loads what it needs.
 */
export function preloadFromText(index: ToolIndexEntry[], text: string): string[] {
  const t = ` ${norm(text)} `;
  if (t.trim().length < 3) return [];
  const picked = new Set<string>();
  const groups = new Set(index.map((e) => e.group));
  for (const g of groups) {
    if (g === "Native" || g === "Add-ons") continue;
    const n = norm(g).replace(/\s+/g, "");
    const stem = n.replace(/[^a-z]/g, "").slice(0, 5);
    if ((n.length >= 3 && t.replace(/\s+/g, "").includes(n)) || (stem.length >= 4 && t.includes(stem))) {
      const members = index.filter((e) => e.group === g);
      if (members.length <= PRELOAD_GROUP_MAX) for (const e of members) picked.add(e.name);
    }
  }
  for (const e of index) {
    const prefix = e.group === "Native" || e.group === "Add-ons" ? "" : norm(e.group).replace(/\s+/g, "_") + "_";
    const short = e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
    const words = norm(short.replace(/_/g, " "));
    if (words.length >= 6 && t.includes(` ${words} `)) picked.add(e.name);
  }
  return [...picked];
}

export interface ToolLoader {
  /** Names whose full definition the model sees now (always includes load_tools). */
  active(): string[];
  load(names: string[]): { loaded: string[]; unknown: string[] };
  loadGroup(group: string): string[];
  /** A tool the model called: it stays loaded. */
  touched(name: string): void;
  /** The index for the system prompt. */
  promptSection(): string;
  /** The `load_tools` tool for the AI SDK. */
  aiTool(): any;
  summary(): { total: number; preloaded: string[]; loaded: string[] };
}

export function createToolLoader(index: ToolIndexEntry[], preload: string[] = []): ToolLoader {
  const known = new Map(index.map((e) => [e.name, e]));
  const preloaded = [...new Set(preload.filter((n) => known.has(n)))];
  const active = new Set<string>(preloaded);
  const loadedByModel: string[] = [];

  const load = (names: string[]) => {
    const loaded: string[] = [];
    const unknown: string[] = [];
    for (const raw of names ?? []) {
      const n = String(raw).trim();
      if (!n) continue;
      if (known.has(n)) { if (!active.has(n)) { active.add(n); loadedByModel.push(n); } loaded.push(n); }
      else unknown.push(n);
    }
    return { loaded, unknown };
  };
  const loadGroup = (group: string) => {
    const g = norm(group).replace(/\s+/g, "");
    const names = index.filter((e) => norm(e.group).replace(/\s+/g, "") === g).map((e) => e.name);
    return load(names).loaded;
  };

  return {
    active: () => [LOAD_TOOL_NAME, ...active],
    load,
    loadGroup,
    touched: (name) => { if (known.has(name) && !active.has(name)) { active.add(name); loadedByModel.push(name); } },
    promptSection: () => {
      const groups = new Map<string, ToolIndexEntry[]>();
      for (const e of index) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
      const lines = [...groups.entries()].map(([g, es]) => `${g} (${es.length}): ${es.map((e) => `${e.name} — ${e.summary}`).join(" · ")}`);
      const loaded = [...active];
      return [
        "",
        "",
        `## Tools (${index.length})`,
        `Only the tools listed as loaded carry their full definition right now. To use any other, call \`${LOAD_TOOL_NAME}\` with its names (several at once is fine, or a whole connection with \`group\`); they are available from your next step. Do not say a tool is missing: load it.`,
        ...lines,
        `Loaded now: ${loaded.length ? loaded.join(", ") : "none"}.`,
      ].join("\n");
    },
    aiTool: () => tool({
      description: "Loads the full definition of tools from the index so you can call them in your next step. Name them, or a whole connection with group.",
      inputSchema: z.object({
        names: z.array(z.string()).optional().describe("Tool names from the index"),
        group: z.string().optional().describe("A connection name from the index: loads all its tools"),
      }),
      execute: async ({ names, group }: { names?: string[]; group?: string }) => {
        const r = load(names ?? []);
        const fromGroup = group ? loadGroup(group) : [];
        const all = [...new Set([...r.loaded, ...fromGroup])];
        const parts: string[] = [];
        if (all.length) parts.push(`Loaded: ${all.join(", ")}. Call them now.`);
        if (group && !fromGroup.length) parts.push(`No connection named "${group}" in the index.`);
        if (r.unknown.length) parts.push(`Not in the index: ${r.unknown.join(", ")}.`);
        if (!parts.length) parts.push("Nothing to load: give names or a group from the index.");
        return parts.join(" ");
      },
    }),
    summary: () => ({ total: index.length, preloaded, loaded: [...loadedByModel] }),
  };
}

export interface OnDemandSetup {
  loader: ToolLoader;
  /** What the worker merges into the AI SDK tool map. */
  tools: Record<string, any>;
  /** Appended to the system prompt. */
  promptSection: string;
  /**
   * For generateText, given the tool map the worker finally passes: the active names per
   * step (the loaded ones plus everything the index does not know, such as the vault tools
   * or propose_plan, which must never be filtered out), the touch hook and the uncounted tool.
   */
  llmOptionsFor(toolMap: Record<string, any> | undefined): { activeTools: () => string[]; onToolCalled: (name: string) => void; uncountedTools: string[]; loadToolName: string };
}

/**
 * Everything a worker needs, or null when the index is not worth it: the feature is off,
 * or the agent has at most ON_DEMAND_MIN_TOOLS tools.
 */
export function setupToolsOnDemand(opts: {
  sources: IndexSources;
  allowedNames: string[];
  enabled: boolean;
  /** The user's message (connections and tools named in it get preloaded). */
  text?: string;
  /** Tools to start loaded (the previous task's, a continuation's). */
  preload?: string[];
  minTools?: number;
}): OnDemandSetup | null {
  const min = opts.minTools ?? ON_DEMAND_MIN_TOOLS;
  if (!opts.enabled || opts.allowedNames.length <= min) return null;
  const index = buildToolIndex(opts.sources, opts.allowedNames);
  if (index.length <= min) return null;
  const loader = createToolLoader(index, [...(opts.preload ?? []), ...preloadFromText(index, opts.text ?? "")]);
  const inIndex = new Set(index.map((e) => e.name));
  return {
    loader,
    tools: { [LOAD_TOOL_NAME]: loader.aiTool() },
    promptSection: loader.promptSection(),
    llmOptionsFor: (toolMap) => {
      const outside = Object.keys(toolMap ?? {}).filter((n) => !inIndex.has(n));
      return { activeTools: () => [...new Set([...loader.active(), ...outside])], onToolCalled: (n) => loader.touched(n), uncountedTools: [LOAD_TOOL_NAME], loadToolName: LOAD_TOOL_NAME };
    },
  };
}

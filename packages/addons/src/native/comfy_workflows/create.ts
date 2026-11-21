import { randomUUID } from "node:crypto";

// A workflow made from nothing, in the shape ComfyUI's interface saves.
//
// ComfyUI has two formats for a workflow. The one its server runs (the "API" format) is a
// plain map: each node has a type and its inputs by name, and an input is either a value or
// a reference to another node's output. A model writes that reliably. The one the interface
// opens, saves and shows in the user's list of workflows also says where each node sits on
// the canvas, which link joins which socket, and lists each node's values by position: that
// one is easy to get subtly wrong by hand.
//
// So a new workflow is written in the first format and turned into the second here, against
// what the user's own ComfyUI says each node takes (its /object_info): the inputs that are
// sockets and those that are values, their order, the outputs. Along the way everything
// that would not run is reported in words the model can act on: a node type this ComfyUI
// does not have, an input a node does not take, a model file that is not installed (with
// the installed ones whose name is close), a reference to a node that is not there.

export interface CreateResult {
  /** The workflow in the interface's format; absent when a problem stops it from being built. */
  graph?: any;
  /** What stops this workflow from running. */
  problems: string[];
  /** What was decided on the way, worth telling. */
  notes: string[];
  /** The model files the workflow names, by the input that names them. */
  models: { node: string; type: string; input: string; file: string }[];
}

const MAX_NODES = 200;
const PRIMITIVE = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const MODEL_FILE_RE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

interface InputSpec {
  name: string;
  required: boolean;
  /** A value the interface keeps in the node (a number, a text, a choice); otherwise a socket. */
  widget: boolean;
  /** The socket's type, or the kind of value. */
  type: string;
  /** For a choice: what can be chosen. */
  options?: string[];
  default?: unknown;
  /** The interface adds a "what to do with it after each run" selector right after this value (a seed). */
  control: boolean;
  multiline: boolean;
}

/** The inputs a node type declares, in the order the interface lists them. */
export function inputSpecs(info: any): InputSpec[] {
  const input = info?.input ?? {};
  const out: InputSpec[] = [];
  for (const section of ["required", "optional"] as const) {
    const defs = input[section];
    if (!isRecord(defs)) continue;
    const order: string[] = Array.isArray(info?.input_order?.[section]) ? info.input_order[section] : Object.keys(defs);
    for (const name of order) {
      const spec = defs[name];
      if (!Array.isArray(spec) || !spec.length) continue;
      const kind = spec[0];
      const options = isRecord(spec[1]) ? spec[1] : {};
      const forced = !!(options.forceInput || options.defaultInput);
      // A choice is declared either as the list itself or as "COMBO" with the list in its options.
      const choices: unknown[] | null = Array.isArray(kind) ? kind : kind === "COMBO" && Array.isArray(options.options) ? options.options : null;
      const type = choices ? "COMBO" : String(kind);
      const widget = !forced && (!!choices || PRIMITIVE.has(type) || (typeof options.widgetType === "string" && !!options.widgetType) || !!options.socketless);
      out.push({
        name,
        required: section === "required",
        widget,
        type,
        ...(choices ? { options: choices.map((c) => String(c)) } : {}),
        default: options.default ?? (choices ? choices[0] : type === "INT" || type === "FLOAT" ? 0 : type === "BOOLEAN" ? false : type === "STRING" ? "" : undefined),
        control: widget && (options.control_after_generate === true || (type === "INT" && (name === "seed" || name === "noise_seed"))),
        multiline: type === "STRING" && options.multiline === true,
      });
    }
  }
  return out;
}

/** A reference to another node's output, as the API format writes it: [node id, output index]. */
const asLink = (v: unknown): { from: string; slot: number } | null =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && Number.isInteger(v[1]) && (v[1] as number) >= 0
    ? { from: String(v[0]), slot: v[1] as number }
    : null;

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** The installed names closest to the one asked for: the ones sharing the most words with it. */
export function closestOptions(wanted: string, options: string[], max = 6): string[] {
  const want = new Set(words(wanted.replace(MODEL_FILE_RE, "")));
  if (!want.size) return options.slice(0, max);
  return options
    .map((o) => ({ o, score: words(o.replace(MODEL_FILE_RE, "")).filter((w) => want.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.length - b.o.length)
    .slice(0, max)
    .map((x) => x.o);
}

/** A choice given without its folder, its extension or its exact capitals, when exactly one installed name fits. */
function resolveOption(value: string, options: string[]): string | null {
  if (options.includes(value)) return value;
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const bare = (s: string) => norm(s).split("/").pop()!.replace(MODEL_FILE_RE, "");
  const same = options.filter((o) => norm(o) === norm(value));
  if (same.length === 1) return same[0];
  const byName = options.filter((o) => bare(o) === bare(value));
  return byName.length === 1 ? byName[0] : null;
}

const COLUMN = 440;
const GAP = 50;
const LEFT = 60;
const TOP = 80;

/** A node's size on the canvas, close to what the interface gives it. */
function sizeOf(type: string, specs: InputSpec[], outputs: number): [number, number] {
  const widgets = specs.filter((s) => s.widget);
  const sockets = specs.filter((s) => !s.widget).length;
  const multiline = widgets.filter((s) => s.multiline).length;
  const rows = Math.max(sockets, outputs) + widgets.length - multiline + widgets.filter((s) => s.control).length;
  let height = 46 + rows * 26 + multiline * 120;
  // Nodes that show a picture need room for it.
  if (/^(Save|Preview)(Image|Animated|Video|3D|GLB|Audio)|^Preview3D/.test(type)) height += 300;
  return [multiline ? 400 : 340, Math.max(height, 60)];
}

/**
 * Turns a workflow written in the API format into the one ComfyUI's interface opens, laid
 * out left to right in the order the data flows. `nodeInfo` gives a node type's definition
 * as ComfyUI describes it (/object_info/<type>), or nothing when the type is not installed.
 * A workflow already in the interface's format is returned as it is.
 */
export function apiToUi(api: unknown, nodeInfo: (type: string) => any): CreateResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const models: CreateResult["models"] = [];
  if (isRecord(api) && Array.isArray(api.nodes)) return { graph: api, problems, notes: ["the workflow was already in the interface's format; it is kept as it is"], models };
  // Some tools wrap the graph: {"prompt": {...}}.
  const source = isRecord(api) && isRecord(api.prompt) && !("class_type" in api.prompt) ? api.prompt : api;
  if (!isRecord(source)) return { problems: ['the workflow has to be an object: {"<node id>": {"class_type": "<node type>", "inputs": {…}}, …}'], notes, models };
  const ids = Object.keys(source);
  if (!ids.length) return { problems: ["the workflow has no nodes"], notes, models };
  if (ids.length > MAX_NODES) return { problems: [`the workflow has ${ids.length} nodes; this tool builds up to ${MAX_NODES}`], notes, models };
  for (const id of ids) {
    const n = source[id];
    if (!isRecord(n) || typeof n.class_type !== "string" || !n.class_type.trim()) problems.push(`node "${id}": it needs "class_type" (the node's type) and "inputs"`);
    else if (n.inputs !== undefined && !isRecord(n.inputs)) problems.push(`node "${id}" (${n.class_type}): "inputs" has to be an object of name → value`);
  }
  if (problems.length) return { problems, notes, models };

  // The interface numbers its nodes; ids that are not numbers get one.
  const numeric = ids.every((id) => /^[1-9]\d{0,8}$/.test(id));
  const uiId = new Map<string, number>(ids.map((id, i) => [id, numeric ? Number(id) : i + 1]));
  if (!numeric) notes.push(`the nodes were numbered in the order given (${ids.slice(0, 12).map((id) => `${id} → ${uiId.get(id)}`).join(", ")}${ids.length > 12 ? ", …" : ""})`);

  const infos = new Map<string, any>();
  const specsOf = new Map<string, InputSpec[]>();
  for (const id of ids) {
    const type = source[id].class_type as string;
    if (!infos.has(type)) infos.set(type, nodeInfo(type));
    const info = infos.get(type);
    if (!info) { problems.push(`node "${id}": this ComfyUI has no node type "${type}" (a custom node that is not installed, or a misspelled name)`); continue; }
    specsOf.set(id, inputSpecs(info));
  }
  if (problems.length) return { problems, notes, models };

  // Where the data flows: a node sits one column after the furthest node feeding it.
  const feeds = new Map<string, string[]>();
  for (const id of ids) {
    const from: string[] = [];
    for (const v of Object.values(source[id].inputs ?? {})) { const l = asLink(v); if (l && l.from in source) from.push(l.from); }
    feeds.set(id, from);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  let cycle = false;
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) { cycle = true; return 0; }
    visiting.add(id);
    const d = feeds.get(id)!.reduce((m, f) => Math.max(m, depthOf(f) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);
  if (cycle) return { problems: ["the workflow has a loop: a node's input comes, through other nodes, from its own output"], notes, models };

  const nodes = new Map<string, any>();
  for (const id of ids) {
    const raw = source[id];
    const type = raw.class_type as string;
    const info = infos.get(type);
    const specs = specsOf.get(id)!;
    const given: Record<string, unknown> = { ...(raw.inputs ?? {}) };
    const where = `node "${id}" (${type})`;
    const sockets: any[] = [];
    const converted: any[] = [];
    const values: unknown[] = [];

    for (const spec of specs) {
      const has = Object.prototype.hasOwnProperty.call(given, spec.name);
      const value = given[spec.name];
      delete given[spec.name];
      const link = asLink(value);
      if (link && !(link.from in source)) { problems.push(`${where}: "${spec.name}" refers to node "${link.from}", which is not in the workflow`); continue; }

      if (!spec.widget) {
        if (has && !link && value !== null && value !== undefined) { problems.push(`${where}: "${spec.name}" is a connection (${spec.type}); it takes ["<node id>", <output index>], not the value ${JSON.stringify(value)?.slice(0, 60)}`); continue; }
        if (!link && spec.required) problems.push(`${where}: "${spec.name}" (${spec.type}) is required and nothing is connected to it`);
        sockets.push({ name: spec.name, type: spec.type, link: link ?? null });
        continue;
      }

      if (link) {
        // A value that comes from another node: the interface keeps a placeholder and a socket for it.
        values.push(spec.default ?? null);
        if (spec.control) values.push("fixed");
        converted.push({ name: spec.name, type: spec.type, widget: { name: spec.name }, link });
        continue;
      }
      let v = has && value !== undefined && value !== null ? value : spec.default;
      if (!has && spec.required && spec.default === undefined) problems.push(`${where}: "${spec.name}" is required and has no value`);
      if (spec.options && typeof v === "string") {
        const found = resolveOption(v, spec.options);
        if (found === null && has) {
          const close = closestOptions(v, spec.options);
          const isModel = MODEL_FILE_RE.test(v) || spec.options.some((o) => MODEL_FILE_RE.test(o));
          problems.push(`${where}: "${spec.name}" is "${v}", which ${isModel ? "is not a file installed in this ComfyUI" : "is not one of its choices"}. ${close.length ? `Closest: ${close.map((c) => `"${c}"`).join(", ")}` : spec.options.length ? `It has ${spec.options.length} choices, e.g. ${spec.options.slice(0, 6).map((c) => `"${c}"`).join(", ")}` : "This ComfyUI has none installed for it"}`);
        } else if (found !== null) {
          if (found !== v) notes.push(`${where}: "${spec.name}" set to the installed name "${found}" (given as "${v}")`);
          v = found;
        }
      }
      if ((spec.type === "INT" || spec.type === "FLOAT") && typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
      if ((spec.type === "INT" || spec.type === "FLOAT") && typeof v !== "number") problems.push(`${where}: "${spec.name}" takes a number, not ${JSON.stringify(v)?.slice(0, 60)}`);
      if (typeof v === "string" && MODEL_FILE_RE.test(v)) models.push({ node: id, type, input: spec.name, file: v });
      values.push(v);
      // A seed is saved as it was given and changes on each run from the interface, as the official workflows do.
      if (spec.control) values.push("randomize");
    }
    for (const extra of Object.keys(given)) {
      problems.push(`${where}: it has no input "${extra}". Its inputs: ${specs.map((s) => s.name).join(", ") || "(none)"}`);
    }

    const outTypes: unknown[] = Array.isArray(info.output) ? info.output : [];
    const outNames: unknown[] = Array.isArray(info.output_name) ? info.output_name : [];
    const outputs = outTypes.map((t, i) => ({ name: String(outNames[i] ?? (Array.isArray(t) ? "COMBO" : t)), type: Array.isArray(t) ? "COMBO" : String(t), slot_index: i, links: [] as number[] }));
    const title = typeof raw._meta?.title === "string" && raw._meta.title.trim() ? raw._meta.title.trim().slice(0, 120) : "";
    nodes.set(id, {
      id: uiId.get(id),
      type,
      pos: [0, 0],
      size: sizeOf(type, specs, outputs.length),
      flags: {},
      order: 0,
      mode: 0,
      inputs: [...sockets, ...converted],
      outputs,
      ...(title && title !== info.display_name ? { title } : {}),
      properties: { "Node name for S&R": type },
      widgets_values: values,
    });
  }

  // The links, numbered, each written on both of its ends.
  const links: unknown[] = [];
  for (const id of ids) {
    const node = nodes.get(id);
    node.inputs.forEach((input: any, slot: number) => {
      const l = input.link as { from: string; slot: number } | null;
      if (!l) { input.link = null; return; }
      const from = nodes.get(l.from);
      const out = from?.outputs[l.slot];
      if (!out) {
        problems.push(`node "${id}" (${node.type}): "${input.name}" takes output ${l.slot} of node "${l.from}" (${from?.type}), which has ${from?.outputs.length ?? 0} output(s)${from?.outputs.length ? `: ${from.outputs.map((o: any, i: number) => `${i} = ${o.type}`).join(", ")}` : ""}`);
        input.link = null;
        return;
      }
      if (out.type !== input.type && out.type !== "*" && input.type !== "*" && !input.widget && !String(input.type).split(",").includes(out.type)) {
        problems.push(`node "${id}" (${node.type}): "${input.name}" takes ${input.type}, and output ${l.slot} of node "${l.from}" (${from.type}) is ${out.type}${from.outputs.some((o: any) => o.type === input.type) ? ` (its ${input.type} output is number ${from.outputs.findIndex((o: any) => o.type === input.type)})` : ""}`);
        input.link = null;
        return;
      }
      const linkId = links.length + 1;
      links.push([linkId, from.id, l.slot, node.id, slot, out.type]);
      out.links.push(linkId);
      input.link = linkId;
    });
  }
  if (problems.length) return { problems, notes, models };

  // Columns by depth; inside a column, nodes follow the height of what feeds them.
  const columns = new Map<number, string[]>();
  for (const id of ids) { const d = depth.get(id)!; if (!columns.has(d)) columns.set(d, []); columns.get(d)!.push(id); }
  const centre = new Map<string, number>();
  let order = 0;
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(d)!;
    const wish = (id: string) => { const f = feeds.get(id)!.filter((x) => centre.has(x)); return f.length ? f.reduce((s, x) => s + centre.get(x)!, 0) / f.length : Number.MAX_SAFE_INTEGER; };
    const sorted = d === 0 ? column : [...column].sort((a, b) => wish(a) - wish(b));
    let y = TOP;
    for (const id of sorted) {
      const node = nodes.get(id);
      node.pos = [LEFT + d * COLUMN, y];
      node.order = order++;
      centre.set(id, y + node.size[1] / 2);
      y += node.size[1] + GAP;
    }
  }

  const list = ids.map((id) => nodes.get(id));
  return {
    graph: {
      id: randomUUID(),
      revision: 0,
      last_node_id: list.reduce((m, n) => Math.max(m, n.id), 0),
      last_link_id: links.length,
      nodes: list,
      links,
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    },
    problems,
    notes,
    models,
  };
}

/**
 * "Open in Blender": the fixed piece of Python that a Blender connection is asked to run when
 * the user sends a model from the chat to their Blender, and how its answer is read.
 *
 * No model writes or sees this code. It imports one glTF file into the open scene, inside a
 * new collection named after the file, and removes nothing.
 */

/** The collection's name: the file's name without its extension, reduced to plain characters. */
export function blenderCollectionName(fileName: string): string {
  const stem = String(fileName ?? '').replace(/\.[A-Za-z0-9]+$/, '');
  const clean = stem.normalize('NFKD').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60);
  return clean || 'Imported';
}

// A JSON string is also a valid Python string literal (same escapes for quotes, backslashes
// and control characters), which is what lets a path go into the script as data.
const py = (s: string) => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function blenderImportCode(absPath: string, fileName: string): string {
  return [
    'import bpy, os',
    `PATH = ${py(absPath)}`,
    `NAME = ${py(blenderCollectionName(fileName))}`,
    'if not os.path.isfile(PATH):',
    '    raise RuntimeError("HYDRAOPS_IMPORT_MISSING")',
    'before = set(o.name for o in bpy.data.objects)',
    'bpy.ops.import_scene.gltf(filepath=PATH)',
    'new = [o for o in bpy.data.objects if o.name not in before]',
    'col = bpy.data.collections.new(NAME)',
    'bpy.context.scene.collection.children.link(col)',
    'for o in new:',
    '    for c in list(o.users_collection):',
    '        c.objects.unlink(o)',
    '    col.objects.link(o)',
    'result = {"hydraops_import": "ok", "objects": len(new), "collection": col.name}',
    'print("HYDRAOPS_IMPORT_OK objects=%d collection=%s" % (len(new), col.name))',
  ].join('\n');
}

export type BlenderImportOutcome =
  | { ok: true; objects: number; collection: string }
  | { ok: false; error: 'not_running' | 'file_missing' | 'failed'; detail: string };

/** Reads what the connection's code tool answered (its text, whatever its framing). */
export function parseBlenderImportResult(text: unknown): BlenderImportOutcome {
  const t = String(text ?? '');
  const printed = /HYDRAOPS_IMPORT_OK objects=(\d+) collection=([^\r\n"\\]{1,80})/.exec(t);
  if (printed) return { ok: true, objects: Number(printed[1]), collection: printed[2].trim() };
  if (/"hydraops_import"\s*:\s*"ok"/.test(t)) {
    const objects = /"objects"\s*:\s*(\d+)/.exec(t);
    const collection = /"collection"\s*:\s*"([^"\\]{1,80})"/.exec(t);
    return { ok: true, objects: objects ? Number(objects[1]) : 0, collection: collection ? collection[1] : '' };
  }
  const detail = t.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (/HYDRAOPS_IMPORT_MISSING/.test(t)) return { ok: false, error: 'file_missing', detail };
  if (/not connected|could not connect|connection refused|ECONNREFUSED|is not connected right now|timed out|timeout|is switched off or not available/i.test(t)) {
    return { ok: false, error: 'not_running', detail };
  }
  return { ok: false, error: 'failed', detail };
}

/** The Blender connections this works with (the name the user's MCP entry has, normalized) and the tool that runs code. */
export const BLENDER_SERVERS = ['blenderlab', 'blender'] as const;
export const BLENDER_CODE_TOOL = 'execute_blender_code';

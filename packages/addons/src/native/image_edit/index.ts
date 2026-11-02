import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import { keepToolImage, toolImageMarker } from "../../tool-images.js";
import type { ReportedFile } from "../../result-files.js";
import { resolveConversationFile } from "../../conversation-files.js";
import type sharpType from "sharp";

// image_edit — plain edits of an image file with sharp (libvips): measure it, crop, flip,
// rotate, resize, trim the background away, or compose several images on one canvas (a
// character sheet from single views, a mirrored profile). What an agent used to open Blender
// or a graphics tool for, in milliseconds and with no GPU.
//
// Files come from this task's folder, the user's attachments or the files earlier replies of
// this conversation left (read-only), and the result is written to the task's folder: the
// chat shows it next to the answer, and a model that sees images gets a light copy to check
// its own work (see tool-images.ts). Nothing else is read or written, so no call waits for
// approval.
const MAX_INPUT_PIXELS = 64_000_000;
const MAX_CANVAS_SIDE = 16_384;
const MAX_LAYERS = 16;
const PREVIEW_SIDE = 1024;
const NAME_RE = /^[\w.\-() ]{1,120}$/;

type Sharp = typeof sharpType;
let sharpModule: Promise<Sharp> | null = null;
async function loadSharp(): Promise<Sharp> {
  if (!sharpModule) sharpModule = import("sharp").then((m: any) => (m.default ?? m) as Sharp);
  return sharpModule;
}

/** A file this task wrote, the user attached, or an earlier reply of this conversation left. */
async function taskFile(ref: string, ctx?: ToolContext): Promise<string | { error: string }> {
  const earlier = await resolveConversationFile(ref, ctx?.conversationFiles?.());
  if (earlier) return earlier.absPath;
  const roots = [ctx?.filesDir, ctx?.uploadsDir].filter((d): d is string => !!d);
  if (!roots.length) return { error: "this task has no files to edit" };
  for (const root of roots) {
    const candidate = path.isAbsolute(ref) ? ref : path.join(root, ref);
    const real = await realpath(candidate).catch(() => "");
    const base = await realpath(root).catch(() => path.resolve(root));
    if (!real || (real !== base && !real.startsWith(base + path.sep))) continue;
    const st = await stat(real).catch(() => null);
    if (st?.isFile()) return real;
  }
  return { error: `"${path.basename(ref)}" is not a file of this task, one the user attached, or one from earlier in this conversation (use the path as the conversation shows it)` };
}

/** Where the result goes: the task's folder, under a name that does not overwrite anything. */
async function outputPath(name: string | undefined, fallback: string, ctx?: ToolContext): Promise<string | { error: string }> {
  if (!ctx?.filesDir) return { error: "this task has no folder to write the result to" };
  let base = (name ?? fallback).trim().replace(/\.(png|jpe?g|webp)$/i, "");
  if (!NAME_RE.test(base) || base === "." || base === "..") return { error: `"${name}" is not a valid file name (letters, digits, spaces, . _ - ( ) only)` };
  await mkdir(ctx.filesDir, { recursive: true });
  let candidate = path.join(ctx.filesDir, `${base}.png`);
  for (let i = 2; await stat(candidate).then(() => true, () => false); i++) candidate = path.join(ctx.filesDir, `${base}_${i}.png`);
  return candidate;
}

const regionSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0),
  width: z.number().int().min(1), height: z.number().int().min(1),
});
type Region = z.infer<typeof regionSchema>;

const layerSchema = z.object({
  file: z.string().min(1).describe("A file of this task or an attachment."),
  x: z.number().int().describe("Left edge on the canvas, in px."),
  y: z.number().int().describe("Top edge on the canvas, in px."),
  crop: regionSchema.optional().describe("Take only this region of the file first."),
  trim: z.boolean().optional().describe("Cut the plain background away around the subject before placing it."),
  flip: z.enum(["horizontal", "vertical"]).optional().describe("Mirror it before placing."),
  width: z.number().int().min(1).optional().describe("Scale to this width (aspect kept unless height is given too)."),
  height: z.number().int().min(1).optional().describe("Scale to this height (aspect kept unless width is given too)."),
});

const schema = z.object({
  action: z.enum(["info", "crop", "flip", "rotate", "resize", "trim", "transparent", "compose"]),
  file: z.string().optional().describe("The image to work on (not for compose): a file of this task, an attachment, or a file from earlier in this conversation, by the path the conversation shows."),
  region: regionSchema.optional().describe("crop: the region to keep, in px from the top-left corner."),
  direction: z.enum(["horizontal", "vertical"]).optional().describe("flip: horizontal mirrors left-right (default), vertical top-bottom."),
  degrees: z.number().optional().describe("rotate: clockwise degrees; 90/180/270 keep every pixel, other angles fill the corners with the background color."),
  width: z.number().int().min(1).optional().describe("resize: new width in px (aspect kept unless height is given too)."),
  height: z.number().int().min(1).optional().describe("resize: new height in px."),
  threshold: z.number().min(0).max(255).optional().describe("trim/info/transparent: how different from the background color a pixel may be and still count as background (default 10; raise it for JPEG noise or soft shadows)."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("transparent: the background color to make see-through, as #rrggbb. Default: the color of the top-left pixel."),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Fill color as #rrggbb (rotate corners, compose canvas); default white."),
  canvas: z.object({ width: z.number().int().min(1).max(MAX_CANVAS_SIDE), height: z.number().int().min(1).max(MAX_CANVAS_SIDE) }).optional().describe("compose: the size of the sheet in px."),
  layers: z.array(layerSchema).min(1).max(MAX_LAYERS).optional().describe("compose: the images to place, in paint order."),
  equal_heights: z.boolean().optional().describe("compose: scale every layer (after its crop/trim) to the same height, the tallest one's, so the figures match."),
  output: z.string().optional().describe("Name for the result (saved as PNG in this task's folder). Default: derived from the source."),
});
type Args = z.infer<typeof schema>;

export const imageEditTool: HydraTool = {
  name: "image_edit",
  title: "Image edit",
  risk: {},
  description:
    "Edit an image file of this task, an attachment, or a file from earlier in this conversation: info (size and the subject's bounding box), crop, flip, rotate, resize, trim (cut the plain background away), transparent (make a flat background see-through: a sprite or a logo on a plain color becomes a PNG with alpha), or compose several images on one canvas (a sheet of views, a mirrored profile placed next to the original; equal_heights matches the figures). The result is saved as PNG in this task's folder and shown to you to check. No GPU, no approval; nothing outside the task is touched.",
  schema,
  execute: async (args: Args, ctx?: ToolContext) => {
    let sharp: Sharp;
    try { sharp = await loadSharp(); } catch (e: any) { return `image_edit is not available on this install: ${e?.message ?? e}`; }
    const open = (file: string) => sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" });
    const bg = args.background ?? "#ffffff";

    if (args.action === "compose") {
      if (!args.canvas || !args.layers) return "compose needs canvas {width, height} and layers [...].";
      const { width: cw, height: ch } = args.canvas;
      if (cw * ch > MAX_INPUT_PIXELS) return `A canvas of ${cw} × ${ch} px is too large (${MAX_INPUT_PIXELS / 1_000_000} MP at most).`;
      const prepared: { buf: Buffer; w: number; h: number; layer: z.infer<typeof layerSchema> }[] = [];
      for (const layer of args.layers) {
        const file = await taskFile(layer.file, ctx);
        if (typeof file !== "string") return file.error;
        let img = open(file);
        if (layer.crop) {
          const meta = await img.metadata();
          const bad = regionProblem(layer.crop, meta.width ?? 0, meta.height ?? 0, layer.file);
          if (bad) return bad;
          img = img.extract({ left: layer.crop.x, top: layer.crop.y, width: layer.crop.width, height: layer.crop.height });
        }
        if (layer.trim) img = img.trim({ threshold: args.threshold ?? 10 });
        if (layer.flip === "horizontal") img = img.flop();
        else if (layer.flip === "vertical") img = img.flip();
        if (layer.width || layer.height) img = img.resize({ width: layer.width, height: layer.height, fit: layer.width && layer.height ? "fill" : "inside" });
        const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
        prepared.push({ buf: data, w: info.width, h: info.height, layer });
      }
      if (args.equal_heights) {
        const target = Math.max(...prepared.map((p) => p.h));
        for (const p of prepared) {
          if (p.h === target) continue;
          const { data, info } = await sharp(p.buf).resize({ height: target }).png().toBuffer({ resolveWithObject: true });
          p.buf = data; p.w = info.width; p.h = info.height;
        }
      }
      const placed: string[] = [];
      for (const p of prepared) {
        const { x, y } = p.layer;
        if (x < 0 || y < 0 || x + p.w > cw || y + p.h > ch) return `"${path.basename(p.layer.file)}" prepared is ${p.w} × ${p.h} px and at (${x}, ${y}) it would leave the ${cw} × ${ch} canvas; move it, scale it, or enlarge the canvas.`;
        placed.push(`${path.basename(p.layer.file)} → (${x}, ${y}) ${p.w} × ${p.h} px`);
      }
      const out = await outputPath(args.output, "composed", ctx);
      if (typeof out !== "string") return out.error;
      await sharp({ create: { width: cw, height: ch, channels: 3, background: bg } })
        .composite(prepared.map((p) => ({ input: p.buf, left: p.layer.x, top: p.layer.y })))
        .png().toFile(out);
      return finish(sharp, out, `Composed ${prepared.length} layer(s) on a ${cw} × ${ch} px canvas:\n- ${placed.join("\n- ")}`, ctx);
    }

    if (!args.file) return `${args.action} needs file: the image to work on.`;
    const file = await taskFile(args.file, ctx);
    if (typeof file !== "string") return file.error;
    const stem = path.basename(file).replace(/\.[^.]+$/, "");
    const meta = await open(file).metadata().catch((e: any) => ({ error: String(e?.message ?? e) } as any));
    if (meta.error || !meta.width || !meta.height) return `"${path.basename(file)}" could not be read as an image${meta.error ? ` (${meta.error})` : ""}.`;
    const W = meta.width, H = meta.height;

    if (args.action === "info") {
      const box = await subjectBox(sharp, file, args.threshold ?? 10);
      return `"${path.basename(file)}": ${W} × ${H} px, ${meta.format ?? "unknown format"}${meta.hasAlpha ? ", with transparency" : ""}.` +
        (box ? ` Subject (what differs from the corner color): x ${box.x}, y ${box.y}, ${box.width} × ${box.height} px.` : " The image is one flat color.");
    }

    let img = open(file);
    let what: string;
    if (args.action === "crop") {
      if (!args.region) return "crop needs region {x, y, width, height}.";
      const bad = regionProblem(args.region, W, H, path.basename(file));
      if (bad) return bad;
      img = img.extract({ left: args.region.x, top: args.region.y, width: args.region.width, height: args.region.height });
      what = `Cropped "${path.basename(file)}" to the region at (${args.region.x}, ${args.region.y}), ${args.region.width} × ${args.region.height} px.`;
    } else if (args.action === "flip") {
      img = args.direction === "vertical" ? img.flip() : img.flop();
      what = `Mirrored "${path.basename(file)}" ${args.direction === "vertical" ? "top-bottom" : "left-right"}.`;
    } else if (args.action === "rotate") {
      if (typeof args.degrees !== "number" || !Number.isFinite(args.degrees)) return "rotate needs degrees.";
      img = img.rotate(args.degrees, { background: bg });
      what = `Rotated "${path.basename(file)}" ${args.degrees}° clockwise.`;
    } else if (args.action === "transparent") {
      const out = await outputPath(args.output, `${stem}_transparent`, ctx);
      if (typeof out !== "string") return out.error;
      let made: { key: string; share: number };
      try { made = await keyOut(sharp, file, out, args.color, args.threshold ?? 10); } catch (e: any) { return `transparent failed: ${e?.message ?? e}`; }
      if (made.share === 0) return `No pixel of "${path.basename(file)}" is close to ${made.key}; nothing was made transparent. Say the background color with "color", or raise "threshold".`;
      return finish(sharp, out, `Made the ${made.key} background of "${path.basename(file)}" transparent (${Math.round(made.share * 100)}% of the pixels).`, ctx);
    } else if (args.action === "resize") {
      if (!args.width && !args.height) return "resize needs width and/or height.";
      if ((args.width ?? 0) * (args.height ?? 0) > MAX_INPUT_PIXELS || (args.width ?? 0) > MAX_CANVAS_SIDE || (args.height ?? 0) > MAX_CANVAS_SIDE) return "That size is too large.";
      img = img.resize({ width: args.width, height: args.height, fit: args.width && args.height ? "fill" : "inside" });
      what = `Resized "${path.basename(file)}" (was ${W} × ${H} px).`;
    } else {
      img = img.trim({ threshold: args.threshold ?? 10 });
      what = `Trimmed the background around the subject of "${path.basename(file)}" (was ${W} × ${H} px).`;
    }
    const out = await outputPath(args.output, `${stem}_${args.action}`, ctx);
    if (typeof out !== "string") return out.error;
    try { await img.png().toFile(out); } catch (e: any) { return `${args.action} failed: ${e?.message ?? e}`; }
    return finish(sharp, out, what, ctx);
  },
};

function regionProblem(r: Region, w: number, h: number, name: string): string | null {
  if (r.x + r.width > w || r.y + r.height > h) return `The region (${r.x}, ${r.y}) ${r.width} × ${r.height} px leaves "${name}", which is ${w} × ${h} px.`;
  return null;
}

/**
 * Writes `file` to `out` as a PNG whose pixels within `threshold` of the key color (the one
 * given, else the top-left pixel's) are fully transparent. A hard key, as sprites and logos
 * on a flat background want; returns the key used and the share of pixels keyed out.
 */
async function keyOut(sharp: Sharp, file: string, out: string, color: string | undefined, threshold: number): Promise<{ key: string; share: number }> {
  const { data, info } = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const key = color ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)] : [data[0], data[1], data[2]];
  let keyed = 0;
  const total = info.width * info.height;
  for (let i = 0; i < data.length; i += ch) {
    if (Math.abs(data[i] - key[0]) <= threshold && Math.abs(data[i + 1] - key[1]) <= threshold && Math.abs(data[i + 2] - key[2]) <= threshold) { data[i + 3] = 0; keyed++; }
  }
  // Nothing matched: no file, so the caller can say so without leaving an unchanged copy behind.
  if (keyed) await sharp(data, { raw: { width: info.width, height: info.height, channels: ch as 4 } }).png().toFile(out);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return { key: `#${hex(key[0])}${hex(key[1])}${hex(key[2])}`, share: total ? keyed / total : 0 };
}

/** The bounding box of what differs from the top-left corner's color, or null for a flat image. */
async function subjectBox(sharp: Sharp, file: string, threshold: number): Promise<Region | null> {
  try {
    const { info } = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).trim({ threshold }).toBuffer({ resolveWithObject: true });
    const left = -(info.trimOffsetLeft ?? 0), top = -(info.trimOffsetTop ?? 0);
    return { x: left, y: top, width: info.width, height: info.height };
  } catch { return null; }
}

/** The saved result: reported to the chat, and a light copy handed to the model to look at. */
async function finish(sharp: Sharp, out: string, what: string, ctx?: ToolContext): Promise<string> {
  const meta = await sharp(out).metadata();
  const size = (await stat(out)).size;
  ctx?.addResultFile?.({ absPath: out, kind: "image", size } as ReportedFile);
  let marker = "";
  try {
    const webp = await sharp(out).resize({ width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const id = keepToolImage("image/webp", webp.toString("base64"));
    if (id) marker = `\n${toolImageMarker(id, "image/webp", Math.max(1, Math.round(webp.length / 1024)))}`;
  } catch { /* the file is saved either way */ }
  return `${what}\nSaved "${path.basename(out)}" (${meta.width} × ${meta.height} px, ${Math.max(1, Math.round(size / 1024))} KB) in this task's folder; use that name in the next step (a ComfyUI prepare, another edit).${marker}\nLook at it before you report: is it what was asked (the right region, the right side mirrored, nothing cut)?`;
}

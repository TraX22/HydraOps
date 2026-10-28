import path from "node:path";
import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";

// calendar — the shared calendar (Complementos → Calendar) from an agent's side: read the
// agenda, add a note or schedule an action, change or remove an entry. The entries live in
// HydraOps' database; the tools talk to the local API, which owns the rules (who may touch
// what, the limits, the copies of attachments) and the clock that runs actions when due.
//
// Approval: a note is free (context only). Scheduling an ACTION is work set up for later,
// so the call is held for the user; approved, it is replayed here with the same arguments
// and the entry is written. Changing or removing an entry always asks; an agent may change
// the user's own entries (with that approval) but never remove them: the API refuses.
const apiUrl = () => (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const MAX_OUTPUT = 60_000;

const HELD = { sensitive: true, approval: "always" as const };

/** This task's id, from the folder the worker bound (storage/results/<task>). */
const taskIdOf = (ctx?: ToolContext): string | undefined => (ctx?.filesDir ? path.basename(ctx.filesDir) : undefined);

async function call(method: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(`${apiUrl()}/api/calendar${route}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: `the calendar did not answer (${e?.message ?? e})` } };
  }
}

const fail = (r: { status: number; data: any }) => `Calendar: ${r.data?.error ?? `HTTP ${r.status}`}${r.data?.detail ? ` — ${r.data.detail}` : ""}`;

function line(e: any): string {
  const who = e.owner === "user" ? "the user" : e.owner;
  const what = e.kind === "action" ? `action for ${e.agentId ?? e.owner}` : "note";
  const extra = [e.repeat && e.repeat !== "none" ? `repeats ${e.repeat}${e.repeatUntil ? ` until ${e.repeatUntil}` : ""}` : "", e.status !== "scheduled" ? e.status : "", e.attachments?.length ? `${e.attachments.length} attachment(s)` : "", Array.isArray(e.origins) && e.origins.length ? "written from outside content" : ""].filter(Boolean).join("; ");
  return `- ${e.id} · ${e.date}${e.time ? ` ${e.time}` : " (all day)"} ${e.timezone} · ${e.title} (${who}; ${what}${extra ? `; ${extra}` : ""})${e.notes ? `\n    ${String(e.notes).slice(0, 300).replace(/\n/g, " ")}` : ""}`;
}

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, in the entry's time zone.");
const timeField = z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM (24 h) in the entry's time zone; leave out for an all-day note.");

export const calendarListTool: HydraTool = {
  name: "calendar_list",
  title: "Calendar: list",
  risk: {},
  description: "The shared calendar: entries between two dates (default: today and the next 14 days), with their ids. Notes are context the user or an agent left; actions are tasks scheduled for an agent. Nothing changes.",
  schema: z.object({
    from: dateField.optional(),
    to: dateField.optional(),
    days: z.number().int().min(1).max(366).optional().describe("Instead of `to`: how many days from `from` (default 14)."),
    owner: z.string().max(64).optional().describe('Only one owner\'s entries: an agent id, or "user".'),
    include_past: z.boolean().optional().describe("Also entries already done, missed or cancelled in the range."),
  }),
  execute: async (args: any, ctx?: ToolContext) => {
    const q = new URLSearchParams();
    if (args.from) q.set("from", args.from);
    if (args.to) q.set("to", args.to);
    if (args.days) q.set("days", String(args.days));
    if (args.owner) q.set("owner", args.owner);
    if (args.include_past) q.set("all", "1");
    const r = await call("GET", `?${q}`);
    if (!r.ok) return fail(r);
    const rows: any[] = r.data?.entries ?? [];
    if (!rows.length) return `No calendar entries ${r.data?.from && r.data?.to ? `between ${r.data.from} and ${r.data.to}` : "in that range"} (${r.data?.timezone ?? ""}).`;
    const text = `${rows.length} entr${rows.length === 1 ? "y" : "ies"} between ${r.data.from} and ${r.data.to} (times in each entry's zone; the user's zone is ${r.data.timezone}):\n${rows.map(line).join("\n")}`.slice(0, MAX_OUTPUT);
    // An entry written by a task that had read outside content is handed over as external
    // data, and this task is marked as having read it.
    const tainted = rows.some((e) => Array.isArray(e.origins) && e.origins.length);
    return tainted && ctx?.external ? ctx.external("calendar_list", undefined, text) : text;
  },
};

export const calendarAddTool: HydraTool = {
  name: "calendar_add",
  title: "Calendar: add",
  risk: (args: any) => (args?.kind === "action" ? HELD : {}),
  description:
    "Add an entry to the shared calendar. A `note` (a meeting, a delivery, a reminder) is written at once and the agents see it in their agenda; a timed note reminds the user on Telegram at its time. An `action` schedules a task: at the date and time, `agent` (default: you) gets `prompt` as a new task in its chat, with the `attachments` named here copied now so they survive. Scheduling an action waits for the user's approval; once approved it runs at its time without asking again. Repeats: daily, weekly, monthly, yearly (with `repeat_until` or up to 365 times).",
  schema: z.object({
    kind: z.enum(["note", "action"]),
    title: z.string().min(1).max(200),
    date: dateField,
    time: timeField.optional(),
    timezone: z.string().max(64).optional().describe("IANA zone, e.g. America/Argentina/Buenos_Aires; default: the user's zone."),
    notes: z.string().max(4000).optional().describe("What the entry is about, for whoever reads the agenda."),
    repeat: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).optional(),
    repeat_until: dateField.optional(),
    agent: z.string().max(64).optional().describe("action: the agent that runs it (default: you)."),
    prompt: z.string().max(8000).optional().describe("action: the task's text, written as the user would ask it in the chat."),
    attachments: z.array(z.string().min(1).max(300)).max(12).optional().describe("action: files of this task or the user's attachments the task will need (by name); copied now."),
  }),
  execute: async (args: any, ctx?: ToolContext) => {
    const by = ctx?.agentId ?? "user";
    if (args.kind === "action" && !args.prompt) return "An action needs `prompt`: what the agent has to do when the time comes.";
    // Where this task had read outside content: the entry carries it, so what it says
    // never reaches another agent as trusted context (see provenance.ts).
    const origins = ctx?.taintOrigins?.() ?? [];
    const r = await call("POST", "", {
      by, owner: by, kind: args.kind, title: args.title, date: args.date, time: args.time ?? null, timezone: args.timezone, notes: args.notes,
      repeat: args.repeat ?? "none", repeatUntil: args.repeat_until, agentId: args.kind === "action" ? (args.agent ?? by) : undefined, prompt: args.prompt,
      attachments: args.attachments ?? [], createdByTask: taskIdOf(ctx), origins,
    });
    if (!r.ok) return fail(r);
    const e = r.data?.entry;
    return `Added to the calendar (id ${e.id}): ${e.title} — ${e.date}${e.time ? ` ${e.time}` : " (all day)"} ${e.timezone}${e.repeat !== "none" ? `, repeats ${e.repeat}` : ""}.${e.kind === "action" ? ` ${e.agentId} will get it as a task then${e.attachments?.length ? `, with ${e.attachments.length} attachment(s) kept` : ""}.` : ""}${r.data?.warning ? `\nNote: ${r.data.warning}` : ""}`;
  },
};

export const calendarUpdateTool: HydraTool = {
  name: "calendar_update",
  title: "Calendar: update",
  risk: HELD,
  description: "Change an entry of the shared calendar (its title, notes, date, time, repeat, or an action's prompt or agent). Waits for the user's approval. The entry id comes from calendar_list.",
  schema: z.object({
    id: z.string().min(8).max(40),
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(4000).optional(),
    date: dateField.optional(),
    time: timeField.nullable().optional(),
    timezone: z.string().max(64).optional(),
    repeat: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).optional(),
    repeat_until: dateField.nullable().optional(),
    agent: z.string().max(64).optional(),
    prompt: z.string().max(8000).optional(),
  }),
  execute: async (args: any, ctx?: ToolContext) => {
    const { id, repeat_until, agent, ...rest } = args;
    const r = await call("PATCH", `/${encodeURIComponent(id)}`, { by: ctx?.agentId ?? "user", ...rest, repeatUntil: repeat_until, agentId: agent });
    if (!r.ok) return fail(r);
    const e = r.data?.entry;
    return `Updated (id ${e.id}): ${e.title} — ${e.date}${e.time ? ` ${e.time}` : " (all day)"} ${e.timezone}${e.repeat !== "none" ? `, repeats ${e.repeat}` : ""}.`;
  },
};

export const calendarRemoveTool: HydraTool = {
  name: "calendar_remove",
  title: "Calendar: remove",
  risk: HELD,
  description: "Remove an entry of the shared calendar (a scheduled action no longer runs). Waits for the user's approval. An agent cannot remove the user's own entries, only its own and other agents'.",
  schema: z.object({ id: z.string().min(8).max(40) }),
  execute: async (args: any, ctx?: ToolContext) => {
    const r = await call("DELETE", `/${encodeURIComponent(args.id)}`, { by: ctx?.agentId ?? "user" });
    if (!r.ok) return fail(r);
    return `Removed from the calendar: ${r.data?.entry?.title ?? args.id}.`;
  },
};

export const calendarTools: HydraTool[] = [calendarListTool, calendarAddTool, calendarUpdateTool, calendarRemoveTool];

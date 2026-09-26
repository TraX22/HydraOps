// /plan over Telegram (see @hydraops/addons plan.ts). When an agent proposes a plan,
// every paired chat gets it with ▶ Approve / ✕ Discard buttons (editing and revising
// stay in the app); a press goes to the same API calls as the chat card. When the
// plan is decided elsewhere, the notice loses its buttons and says how it went.

import { tasks } from "@hydraops/db";
import { and, eq, inArray } from "drizzle-orm";

export interface PlansDeps {
  db: any;
  apiUrl: string;
  apiHeaders: (extra?: Record<string, string>) => Record<string, string>;
  getConfig: () => Promise<{ enabled: boolean; allowlist: number[]; notifications?: { heldActions?: boolean } }>;
  getToken: () => Promise<string>;
  tg: (token: string, method: string, params: Record<string, unknown>) => Promise<any>;
}

const POLL_MS = 15_000;
const CALLBACK = /^plan:(a|d):([0-9a-f-]{36})$/i;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const sentNotices = new Map<string, { chatId: number; messageId: number; text: string }[]>();
const MAX_TRACKED = 200;

// The plan as the chat card shows it, in plain text (Telegram has no card).
function describe(row: any): string {
  const plan = row.plan ?? {};
  const agent = String(row.assignedAgent ?? "an agent");
  const lines: string[] = [`🗺️ Plan from ${agent}${plan.version > 1 ? ` (v${plan.version})` : ""} — waiting for your OK`];
  if (plan.goal) lines.push(clip(String(plan.goal), 300));
  lines.push("");
  const steps: any[] = Array.isArray(plan.steps) ? plan.steps : [];
  steps.forEach((st, i) => {
    const mark = st.change === "removed" ? "✕ " : st.change === "added" ? "+ " : st.change === "changed" ? "~ " : "";
    const extras: string[] = [];
    if (st.agent) extras.push(`→ ${st.agent}`);
    if (Array.isArray(st.tools) && st.tools.length) extras.push(st.tools.join(", "));
    lines.push(`${i + 1}. ${mark}${clip(String(st.title ?? ""), 200)}${extras.length ? ` (${extras.join(" · ")})` : ""}`);
  });
  if (plan.implications) lines.push("", `↳ ${clip(String(plan.implications), 400)}`);
  const questions: string[] = Array.isArray(plan.questions) ? plan.questions : [];
  if (questions.length) {
    lines.push("", "❓ Before starting:");
    for (const q of questions) lines.push(`• ${clip(String(q), 200)}`);
  }
  lines.push("", "Edit or ask for a revision in the app.");
  return clip(lines.join("\n"), 3800);
}

function outcomeLine(status: string): string {
  switch (status) {
    case "approved": return "▶ Approved — the agent is carrying it out.";
    case "discarded": return "✕ Discarded — nothing runs.";
    case "superseded": return "✏️ Revised in the app — a new version replaces this one.";
    default: return `Decided (${status}).`;
  }
}

async function pendingPlanRows(deps: PlansDeps): Promise<any[]> {
  const rows = await deps.db.select().from(tasks).where(and(eq(tasks.mode, "plan"), eq(tasks.status, "completed")));
  return rows.filter((r: any) => r.plan && typeof r.plan === "object");
}

/** Sends every proposed plan not yet notified, with its buttons. */
async function notifyNew(deps: PlansDeps): Promise<void> {
  const cfg = await deps.getConfig();
  const token = await deps.getToken();
  if (!cfg.enabled || !token || cfg.notifications?.heldActions === false || cfg.allowlist.length === 0) return;
  const fresh = (await pendingPlanRows(deps)).filter((r: any) => r.plan.status === "pending" && !r.plan.notifiedAt);
  for (const row of fresh) {
    // Mark first: a send failure must not turn into a message every 15 s.
    await deps.db.update(tasks).set({ plan: { ...row.plan, notifiedAt: new Date().toISOString() } }).where(eq(tasks.id, row.id)).run();
    const reply_markup = { inline_keyboard: [[
      { text: "▶ Approve", callback_data: `plan:a:${row.id}` },
      { text: "✕ Discard", callback_data: `plan:d:${row.id}` },
    ]] };
    const text = describe(row);
    for (const chatId of cfg.allowlist) {
      try {
        const sent = await deps.tg(token, "sendMessage", { chat_id: chatId, text, reply_markup, disable_web_page_preview: true });
        if (sent?.message_id) {
          if (!sentNotices.has(row.id) && sentNotices.size >= MAX_TRACKED) sentNotices.delete(sentNotices.keys().next().value!);
          sentNotices.set(row.id, [...(sentNotices.get(row.id) ?? []), { chatId, messageId: sent.message_id, text }]);
        }
      } catch (e) {
        console.error(`[telegram-bot] plan notice to ${chatId} failed`, e);
      }
    }
    console.log(`[telegram-bot] plan ${row.id} sent to ${cfg.allowlist.length} chat(s)`);
  }
}

/** Takes the buttons off notices whose plan was decided elsewhere (the app, another chat). */
async function syncDecided(deps: PlansDeps): Promise<void> {
  if (sentNotices.size === 0) return;
  const token = await deps.getToken();
  if (!token) return;
  const rows = await deps.db.select().from(tasks).where(inArray(tasks.id, [...sentNotices.keys()]));
  for (const row of rows) {
    const status = row.plan?.status;
    if (!status || status === "pending") continue;
    const notices = sentNotices.get(row.id) ?? [];
    sentNotices.delete(row.id);
    for (const n of notices) {
      await deps.tg(token, "editMessageText", { chat_id: n.chatId, message_id: n.messageId, text: `${n.text}\n\n${outcomeLine(status)}`, disable_web_page_preview: true }).catch(() => {});
    }
  }
}

export function startPlansNotifier(deps: PlansDeps): void {
  const tick = () => Promise.all([notifyNew(deps), syncDecided(deps)]).catch((e) => console.error("[telegram-bot] plans poll failed", e));
  setTimeout(tick, 7_000);
  setInterval(tick, POLL_MS);
}

/** A press on a plan's button. Returns true when the update was ours. */
export async function handlePlanCallback(deps: PlansDeps, token: string, allowlist: number[], cq: any): Promise<boolean> {
  const m = typeof cq?.data === "string" ? cq.data.match(CALLBACK) : null;
  if (!m) return false;
  const answer = (text: string) => deps.tg(token, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  if (!allowlist.includes(cq.from?.id)) { await answer("🔒 Not authorized."); return true; }
  const decision = m[1].toLowerCase() === "a" ? "approve" : "discard";
  let outcome: string;
  try {
    const res = await fetch(`${deps.apiUrl}/api/plans/${m[2]}/${decision}`, {
      method: "POST", headers: deps.apiHeaders({ "Content-Type": "application/json" }), body: "{}", signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) outcome = decision === "approve" ? outcomeLine("approved") : outcomeLine("discarded");
    else if (data?.error === "already_decided") outcome = outcomeLine(String(data?.status ?? "decided"));
    else outcome = `⚠️ Could not ${decision}: ${data?.error ?? res.status}`;
  } catch (e: any) {
    outcome = `⚠️ Could not reach HydraOps: ${e?.message ?? e}`;
  }
  await answer(outcome);
  const msg = cq.message;
  const tracked = sentNotices.get(m[2]);
  if (tracked && msg?.message_id) {
    const rest = tracked.filter((n) => !(n.chatId === msg.chat?.id && n.messageId === msg.message_id));
    if (rest.length) sentNotices.set(m[2], rest); else sentNotices.delete(m[2]);
  }
  if (msg?.chat?.id && msg?.message_id) {
    await deps.tg(token, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text ?? ""}\n\n${outcome}`, disable_web_page_preview: true }).catch(() => {});
  }
  return true;
}

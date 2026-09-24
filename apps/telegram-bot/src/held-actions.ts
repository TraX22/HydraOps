// Held actions over Telegram (prompt-injection defense, see @hydraops/addons provenance.ts).
//
// When an agent that read outside content wants to act, the call is held for the user.
// While the user is away from the app, this sends each new held call to every
// allowlisted chat with ✅ Approve / ❌ Reject buttons, and turns a button press into the
// same API call the chat card makes. The API does the deciding (expiry, already
// decided, publishing action.approved); the bot only relays.

import { pendingActions } from "@hydraops/db";
import { and, eq, isNull } from "drizzle-orm";

export interface HeldActionsDeps {
  db: any;
  apiUrl: string;
  apiHeaders: (extra?: Record<string, string>) => Record<string, string>;
  getConfig: () => Promise<{ enabled: boolean; allowlist: number[]; notifications?: { heldActions?: boolean } }>;
  getToken: () => Promise<string>;
  tg: (token: string, method: string, params: Record<string, unknown>) => Promise<any>;
}

const POLL_MS = 15_000;
const CALLBACK = /^held:(a|r):([0-9a-f-]{36})$/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describe(a: any): string {
  const origins = (Array.isArray(a.origins) ? a.origins : []).map((o: any) => o?.ref ?? o?.tool).filter(Boolean).slice(0, 3);
  const args = a.args && typeof a.args === "object"
    ? Object.entries(a.args as Record<string, unknown>).slice(0, 6)
        .map(([k, v]) => `• ${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), 300)}`).join("\n")
    : "";
  return [
    `⏸ Held action — ${a.agentId} wants to run ${a.toolName}`,
    `It read outside content first${origins.length ? ` (${origins.join(", ")})` : ""}, so it was not run.`,
    args,
    "Expires in 24 h.",
  ].filter(Boolean).join("\n\n");
}

/** Sends every held call not yet notified, with its buttons. */
async function notifyNew(deps: HeldActionsDeps): Promise<void> {
  const cfg = await deps.getConfig();
  const token = await deps.getToken();
  if (!cfg.enabled || !token || cfg.notifications?.heldActions === false || cfg.allowlist.length === 0) return;
  const fresh = await deps.db.select().from(pendingActions)
    .where(and(eq(pendingActions.status, "pending"), isNull(pendingActions.notifiedAt)));
  for (const a of fresh) {
    // Mark first: a send failure must not turn into a message every 15 s.
    await deps.db.update(pendingActions).set({ notifiedAt: new Date() }).where(eq(pendingActions.id, a.id)).run();
    const reply_markup = {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `held:a:${a.id}` },
        { text: "❌ Reject", callback_data: `held:r:${a.id}` },
      ]],
    };
    for (const chatId of cfg.allowlist) {
      try {
        await deps.tg(token, "sendMessage", { chat_id: chatId, text: describe(a), reply_markup, disable_web_page_preview: true });
      } catch (e) {
        console.error(`[telegram-bot] held-action notice to ${chatId} failed`, e);
      }
    }
    console.log(`[telegram-bot] held action ${a.id} (${a.toolName}) sent to ${cfg.allowlist.length} chat(s)`);
  }
}

export function startHeldActionsNotifier(deps: HeldActionsDeps): void {
  const tick = () => notifyNew(deps).catch((e) => console.error("[telegram-bot] held actions poll failed", e));
  setTimeout(tick, 5_000);
  setInterval(tick, POLL_MS);
}

/**
 * A button press. Returns true when the update was ours (handled or refused). Only an
 * allowlisted user can decide; the message is edited to show the outcome so the buttons
 * cannot be pressed twice.
 */
export async function handleHeldActionCallback(deps: HeldActionsDeps, token: string, allowlist: number[], cq: any): Promise<boolean> {
  const m = typeof cq?.data === "string" ? cq.data.match(CALLBACK) : null;
  if (!m) return false;
  const answer = (text: string) => deps.tg(token, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  if (!allowlist.includes(cq.from?.id)) {
    await answer("🔒 Not authorized.");
    return true;
  }
  const decision = m[1].toLowerCase() === "a" ? "approve" : "reject";
  let outcome: string;
  try {
    const res = await fetch(`${deps.apiUrl}/api/security/actions/${m[2]}/${decision}`, {
      method: "POST",
      headers: deps.apiHeaders({ "Content-Type": "application/json" }),
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) outcome = decision === "approve" ? "✅ Approved — the agent's worker is running it." : "❌ Rejected — it will not run.";
    else if (data?.error === "already_decided") outcome = `Already decided (${data?.action?.status ?? "done"}).`;
    else if (data?.error === "expired") outcome = "⌛ Expired — it will not run.";
    else outcome = `⚠️ Could not ${decision}: ${data?.error ?? res.status}`;
  } catch (e: any) {
    outcome = `⚠️ Could not reach HydraOps: ${e?.message ?? e}`;
  }
  await answer(outcome);
  const msg = cq.message;
  if (msg?.chat?.id && msg?.message_id) {
    await deps.tg(token, "editMessageText", {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: `${msg.text ?? ""}\n\n${outcome}`, disable_web_page_preview: true,
    }).catch(() => {});
  }
  return true;
}

import { config as loadDotenv } from "dotenv";
import { loadEnv, envFile, logsDir, keyStoreFile } from "@hydraops/config";
import { createDb, systemConfigs, workerStatus } from "@hydraops/db";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";

import { dispatch } from "./commands/registry.js";
import type { AgentSummary, CommandContext } from "./commands/types.js";

loadDotenv({ path: envFile });

const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "telegram-bot" });

// --- file logging → storage/logs/<service>.log (served by GET /workers/:id/logs) ---
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
const logStream = createWriteStream(path.join(logsDir, `${env.SERVICE_NAME}.log`), { flags: "a" });
for (const level of ["log", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { logStream.write(`[${new Date().toISOString()}]${level === "error" ? " ERROR:" : ""} ${args.map(String).join(" ")}\n`); } catch { /* ignore */ }
    orig(...args);
  };
}

const { db, pool } = createDb(env.DATABASE_URL);

// HydraOps API is reached over loopback; loopback requests are auth-exempt
// unless HYDRA_AUTH_STRICT=1, in which case we send the bearer token.
const API_URL = (process.env.HYDRA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const AUTH_TOKEN = process.env.HYDRA_AUTH_TOKEN || "";
const apiHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
  AUTH_TOKEN ? { ...extra, Authorization: `Bearer ${AUTH_TOKEN}` } : extra;

const TELEGRAM_KEY_NAME = "TELEGRAM_BOT_TOKEN";
const CONFIG_KEY = "telegram_config";
const KEY_PLACEHOLDER = "proxy";

console.log(`[telegram-bot] Starting — API at ${API_URL}`);

// --- Heartbeat (so /workers shows the bot as online) ---
async function sendHeartbeat() {
  try {
    await (db as any)
      .insert(workerStatus)
      .values({ workerId: "telegram-bot", status: "online", lastHeartbeat: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: workerStatus.workerId,
        set: { status: "online", lastHeartbeat: new Date(), updatedAt: new Date() },
      })
      .run();
  } catch (e) {
    console.error("[telegram-bot] heartbeat failed", e);
  }
}
sendHeartbeat();
setInterval(sendHeartbeat, 20_000);

// --- Persistent config (system_configs.telegram_config) ---
interface TelegramConfig {
  enabled: boolean;
  allowlist: number[];
  pairingCode: string;
  defaultAgent: string;
  /** Per-chat active agent; runtime state owned by the bot. */
  sessions: Record<string, string>;
}

const DEFAULT_CONFIG: TelegramConfig = {
  enabled: false,
  allowlist: [],
  pairingCode: "",
  defaultAgent: "",
  sessions: {},
};

async function readConfig(): Promise<TelegramConfig> {
  try {
    const rows = await (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, CONFIG_KEY)).limit(1);
    if (!rows[0]) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(rows[0].value);
    return { ...DEFAULT_CONFIG, ...parsed, sessions: parsed.sessions ?? {} };
  } catch (e) {
    console.error("[telegram-bot] readConfig failed", e);
    return { ...DEFAULT_CONFIG };
  }
}

// Read-modify-write so the bot never clobbers fields the UI owns (enabled,
// token flag, defaultAgent) when it writes runtime state (allowlist, sessions),
// and vice versa. Low write frequency → last-write-wins is acceptable.
async function updateConfig(mutate: (c: TelegramConfig) => void): Promise<TelegramConfig> {
  const current = await readConfig();
  mutate(current);
  const value = JSON.stringify(current);
  await (db as any)
    .insert(systemConfigs)
    .values({ key: CONFIG_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemConfigs.key, set: { value, updatedAt: new Date() } })
    .run();
  return current;
}

// --- Bot token (real value lives only in the key store, like provider keys) ---
async function readToken(): Promise<string> {
  try {
    const store = JSON.parse(await readFile(keyStoreFile, "utf-8"));
    const v = (store[TELEGRAM_KEY_NAME] || "").trim();
    return v && v !== KEY_PLACEHOLDER ? v : "";
  } catch {
    return "";
  }
}

// --- Telegram Bot API ---
async function tg(token: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

const TG_MAX = 4096;
async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const body = text.trim() || "(empty reply)";
  // Split long replies on newline boundaries under Telegram's 4096-char limit.
  for (let i = 0; i < body.length; ) {
    let end = Math.min(i + TG_MAX, body.length);
    if (end < body.length) {
      const nl = body.lastIndexOf("\n", end);
      if (nl > i + 1000) end = nl;
    }
    await tg(token, "sendMessage", { chat_id: chatId, text: body.slice(i, end), disable_web_page_preview: true });
    i = end;
  }
}

// --- HydraOps API bridge ---
let agentCache: { at: number; agents: AgentSummary[] } = { at: 0, agents: [] };
async function listAgents(): Promise<AgentSummary[]> {
  if (Date.now() - agentCache.at < 30_000 && agentCache.agents.length) return agentCache.agents;
  const res = await fetch(`${API_URL}/api/agents`, { headers: apiHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET /api/agents ${res.status}`);
  const raw = (await res.json()) as any[];
  const agents: AgentSummary[] = raw.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, status: a.status }));
  agentCache = { at: Date.now(), agents };
  return agents;
}

async function hasAgent(id: string): Promise<boolean> {
  return (await listAgents()).some((a) => a.id === id.toLowerCase());
}

// Send a prompt to an agent (channel = agent id → deterministic routing in the
// orchestrator) and poll the task until it completes.
async function sendToAgent(chatId: number, token: string, agentId: string, prompt: string, senderId: string): Promise<string> {
  const createRes = await fetch(`${API_URL}/api/tasks`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt, channel: agentId, userId: senderId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!createRes.ok) throw new Error(`POST /api/tasks ${createRes.status}`);
  const { taskId } = (await createRes.json()) as { taskId: string };

  const deadline = Date.now() + 120_000; // 2 min
  let nextTyping = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextTyping) {
      tg(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      nextTyping = Date.now() + 5_000; // Telegram clears "typing" after ~5s
    }
    await new Promise((r) => setTimeout(r, 1_500));
    try {
      const r = await fetch(`${API_URL}/api/tasks/${taskId}`, { headers: apiHeaders(), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) continue;
      const task = (await r.json()) as any;
      if (task.status === "completed") {
        return task.resultMeta?.text || task.result_meta?.text || "(the agent returned an empty reply)";
      }
      if (task.status === "failed") {
        return `The task failed: ${task.resultMeta?.error || task.result_meta?.error || "unknown error"}`;
      }
    } catch { /* transient — keep polling */ }
  }
  return "The agent is taking too long to answer. It may still be working — check the app.";
}

// --- Long-poll loop ---
let offset = 0;
let currentToken = "";

async function drainBacklog(token: string): Promise<void> {
  // Skip messages received while the bot was down: fetch only the latest update
  // and advance the offset past it without processing.
  try {
    const updates = await tg(token, "getUpdates", { offset: -1, timeout: 0 }, 10_000);
    if (Array.isArray(updates) && updates.length) offset = updates[updates.length - 1].update_id + 1;
  } catch { /* ignore — first real poll will set the offset */ }
}

async function handleUpdate(token: string, cfg: TelegramConfig, update: any): Promise<void> {
  const msg = update.message;
  const text: string = msg?.text ?? "";
  const chatId: number = msg?.chat?.id;
  const fromId: number = msg?.from?.id;
  if (!msg || !chatId || !fromId || !text) return; // v1 handles text messages only

  const authorized = cfg.allowlist.includes(fromId);

  // --- Pairing / access gate (transport-specific, runs before dispatch) ---
  if (!authorized) {
    const m = text.trim().match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
    if (m) {
      const code = (m[1] || "").trim();
      if (cfg.pairingCode && code === cfg.pairingCode) {
        await updateConfig((c) => { if (!c.allowlist.includes(fromId)) c.allowlist.push(fromId); });
        await sendMessage(token, chatId, "✅ Paired. You can now talk to the agents. Try /agents.");
        console.log(`[telegram-bot] paired user ${fromId}`);
      } else {
        await sendMessage(token, chatId, "🔒 Not authorized. Send /start <pairing code> (get it from HydraOps → Herramientas).");
      }
    } else {
      await sendMessage(token, chatId, "🔒 Not authorized. Send /start <pairing code> to link this chat.");
    }
    return;
  }

  // --- Authorized: run the transport-agnostic command layer ---
  const senderId = `tg:${fromId}`;
  const chatKey = String(chatId);
  const ctx: CommandContext = {
    senderId,
    conversationId: chatKey,
    defaultAgent: cfg.defaultAgent || undefined,
    session: {
      get: () => cfg.sessions[chatKey],
      set: async (agentId) => {
        await updateConfig((c) => {
          if (agentId) c.sessions[chatKey] = agentId;
          else delete c.sessions[chatKey];
        });
        cfg.sessions[chatKey] = agentId as string;
      },
    },
    api: {
      listAgents,
      hasAgent,
      sendToAgent: (agentId, prompt) => sendToAgent(chatId, token, agentId, prompt, senderId),
    },
  };

  try {
    const result = await dispatch(text, ctx);
    if (result.text) await sendMessage(token, chatId, result.text);
  } catch (e: any) {
    console.error("[telegram-bot] handleUpdate failed", e);
    await sendMessage(token, chatId, `⚠️ Something went wrong: ${e?.message || e}`).catch(() => {});
  }
}

async function loop(): Promise<void> {
  for (;;) {
    let cfg: TelegramConfig;
    let token: string;
    try {
      cfg = await readConfig();
      token = await readToken();
    } catch (e) {
      console.error("[telegram-bot] config read failed", e);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    // Idle when disabled or unconfigured — re-check every 5s so the UI toggle
    // takes effect without a restart.
    if (!cfg.enabled || !token) {
      if (currentToken) console.log("[telegram-bot] paused (disabled or no token)");
      currentToken = "";
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    // Token (re)appeared or changed → reset the poll cursor and skip backlog.
    if (token !== currentToken) {
      currentToken = token;
      offset = 0;
      await drainBacklog(token);
      console.log("[telegram-bot] active — polling for updates");
    }

    try {
      const updates = await tg(token, "getUpdates", { offset, timeout: 30 }, 40_000);
      for (const u of updates as any[]) {
        offset = u.update_id + 1;
        await handleUpdate(token, cfg, u);
      }
    } catch (e: any) {
      // 409 = another getUpdates poller (e.g. a second instance); back off.
      console.error("[telegram-bot] poll error", e?.message || e);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

loop();

process.on("SIGINT", async () => {
  console.log("[telegram-bot] Shutting down...");
  try { if (pool && "end" in pool) await (pool as any).end(); } catch { /* ignore */ }
  process.exit(0);
});

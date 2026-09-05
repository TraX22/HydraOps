// worker-general — text tasks for agents with workerType 'general'.
// Same pipeline contract as worker-coder: consumes agent.task_assigned,
// loads the agent's personality files, calls the LLM with native tools,
// writes result.json and emits agent.result_generated.
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { loadEnv, envFile, dataRoot, agentsDir, storageDir, logsDir, usersDir, craftDir, readLocalLlmEnv } from "@hydraops/config";

loadDotenv({ path: envFile });

import { createDb, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage, buildCronDedupContext, searchAgentTasks } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType } from "@hydraops/nats";
import { eq, and, desc } from "drizzle-orm";
import { generateText as llmGenerateText, resolveLLMConfig, buildUserMessage } from "@hydraops/llm";
import { createRegistry } from "@hydraops/addons";
import { AckPolicy } from "nats";

const WORKER_TYPE = "general";
const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "worker-general" });
const consumerName = env.SERVICE_NAME;

const rootDir = dataRoot;

// --- file logging → storage/logs/<service>.log (served by GET /workers/:id/logs) ---
import { createWriteStream, mkdirSync } from "node:fs";
try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
const logStream = createWriteStream(path.join(logsDir, `${consumerName}.log`), { flags: "a" });
for (const level of ["log", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { logStream.write(`[${new Date().toISOString()}]${level === "error" ? " ERROR:" : ""} ${args.map(String).join(" ")}\n`); } catch { /* ignore */ }
    orig(...args);
  };
}

const { db, client: sqliteClient } = createDb(env.DATABASE_URL);
const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);
const js = await getJs(nc);

console.log(`[${consumerName}] listening for agent.task_assigned (workerType=${WORKER_TYPE}) on ${env.NATS_URL}`);

const globalRegistry = await createRegistry();
let lastMcpConfigStr = "";

async function sendHeartbeat() {
  try {
    const configs = await (db as any).select().from(agentConfigs);
    for (const cfg of configs) {
      if (cfg.workerType === WORKER_TYPE) {
        await (db as any).update(agentConfigs)
          .set({ lastHeartbeat: new Date() })
          .where(eq(agentConfigs.agentId, cfg.agentId))
          .run();
      }
    }
    await (db as any).insert(workerStatus)
      .values({ workerId: consumerName, status: "online", lastHeartbeat: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: workerStatus.workerId,
        set: { status: "online", lastHeartbeat: new Date(), updatedAt: new Date() },
      })
      .run();
    // Sync MCP status (same contract as worker-coder; only when we have something to report)
    try {
      const statuses = globalRegistry.getServerStatuses();
      if (statuses && statuses.length > 0) {
        await (db as any).insert(systemConfigs)
          .values({ key: `mcp_servers_status:${consumerName}`, value: JSON.stringify(statuses), updatedAt: new Date() })
          .onConflictDoUpdate({
            target: systemConfigs.key,
            set: { value: JSON.stringify(statuses), updatedAt: new Date() },
          })
          .run();
      }
    } catch (e) { console.error(`[${consumerName}] MCP status sync error`, e); }
  } catch { /* silent */ }
}
sendHeartbeat();
setInterval(sendHeartbeat, 20_000);

async function writeLocalResult(taskId: string, payload: unknown) {
  const dir = path.join(storageDir, "results", taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "result.json"), JSON.stringify(payload, null, 2), "utf-8");
  return `results/${taskId}/result.json`;
}

async function loadPersonality(agentId: string): Promise<{ context: string; files: string[] }> {
  const fileTypes = ["agent", "soul", "skill", "tools", "memory", "heartbeat"];
  const files = await Promise.all(
    fileTypes.map(async (type) => {
      try {
        return await readFile(path.join(agentsDir, agentId, `${agentId}.${type}.md`), "utf-8");
      } catch {
        return "";
      }
    })
  );
  const context = files
    .filter((c) => c.trim().length > 0)
    .map((c, i) => `\n--- AGENT ${fileTypes[i].toUpperCase()} ---\n${c}`)
    .join("\n");
  return { context, files };
}

// [CRAFT] — el oficio del tipo de worker (craft/<tipo>.md): la teoría del rol,
// compartida por todos sus agentes. Leído por tarea, como el perfil, para
// poder editarlo en caliente; si falta, el prompt queda como antes.
async function loadCraft(): Promise<string> {
  try {
    const text = (await readFile(path.join(craftDir, `${WORKER_TYPE}.md`), "utf-8")).trim();
    if (!text) return "";
    return `\n[CRAFT — the trade you practice. The agent files below define WHO you are; this defines the profession you bring to every task]\n${text}\n`;
  } catch {
    return "";
  }
}
loadCraft().then((c) => console.log(`[${consumerName}] craft ${c ? `loaded (craft/${WORKER_TYPE}.md)` : "missing — running without trade knowledge"}`));

// [USER PROFILE] block for the system prompt, read fresh from users/profile.json
// on every task (like the personality files) so edits apply without restart.
async function loadUserProfile(): Promise<string> {
  try {
    const p = JSON.parse(await readFile(path.join(usersDir, "profile.json"), "utf-8"));
    const lines = [
      p.name && `- Name: ${p.name}`,
      p.occupation && `- Occupation: ${p.occupation}`,
      p.tools && `- Tools & tech they use: ${p.tools}`,
      p.interests && `- Interests: ${p.interests}`,
      p.notes && `- Notes from the user: ${p.notes}`,
    ].filter(Boolean);
    if (lines.length === 0) return "";
    return `\n\n[USER PROFILE — the human you are talking to. Use this to personalize your answers and recommendations]\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[${consumerName}] Timeout of ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

const sub = await js.pullSubscribe(subjectForType("agent.task_assigned"), {
  stream: "EVENTS",
  config: {
    durable_name: "worker_general_task_assigned",
    ack_policy: AckPolicy.Explicit,
  },
});
sub.pull({ batch: 1, expires: 1000 });
setInterval(() => sub.pull({ batch: 1, expires: 1000 }), 1000);

for await (const m of sub) {
  const started = Date.now();
  let taskId: string | undefined;
  try {
    const envlp = parseEnvelope(JSON.parse(new TextDecoder().decode(m.data)));

    const data = envlp.data as any;
    if (data.workerType !== WORKER_TYPE) {
      m.ack();
      continue;
    }

    const inserted = await (db as any)
      .insert(processedEvents)
      .values({ consumerName, eventId: envlp.id })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    if (inserted.length === 0) {
      m.ack();
      continue;
    }

    taskId = data.taskId as string;
    const agentId = data.agentId as string;
    const channel = (data.channel as string) || "main";

    const taskRows = await (db as any).select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const userPrompt = (data.prompt as string) || taskRows[0]?.prompt || "";
    if (!userPrompt) {
      console.warn(`[${consumerName}] No prompt for task ${taskId}. Skipping.`);
      m.ack();
      continue;
    }

    const agentName = taskRows[0]?.assignedAgent || agentId || "Agent";
    const cfgRows = await (db as any).select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
    // "Tipo" (graphicEngine) overrides when set; 'auto' → agent model → global default.
    const engineOverride = cfgRows[0]?.graphicEngine && cfgRows[0].graphicEngine !== "auto" ? cfgRows[0].graphicEngine : null;
    // 'auto' → modelo del agente → modelo por defecto global. Sin fallback a un
    // proveedor concreto: si no hay ninguno, la tarea falla con aviso claro.
    const selectedModel = engineOverride || cfgRows[0]?.model || process.env.DEFAULT_MODEL || "";
    if (!selectedModel) {
      console.error("[worker-general] ERROR: no hay modelo. Elige uno en Configuración → Modelo por defecto, o asígnaselo al agente.");
    }

    const globalConfigs = await (db as any).select().from(systemConfigs);
    // El LLM local se relee del .env en cada tarea. Es su única fuente (la API
    // lo borra de system_configs a propósito) y el .env solo se carga al
    // arrancar, así que sin esto cambiar de servidor local no surtía efecto
    // hasta reiniciar la aplicación entera.
    const localLlm = readLocalLlmEnv();
    const getGlobalConfig = (key: string, defaultValue: string) => {
      if (key in localLlm) return localLlm[key] || defaultValue;
      const found = globalConfigs.find((c: any) => c.key === key);
      return found ? found.value : process.env[key] || defaultValue;
    };

    let llmConfig = resolveLLMConfig(selectedModel, getGlobalConfig);
    if (llmConfig.provider === "leonardo") {
      llmConfig = resolveLLMConfig(process.env.DEFAULT_MODEL || "", getGlobalConfig);
    }

    const { context: personality, files: personalityFiles } = await loadPersonality(agentId);
    const craft = await loadCraft();
    const userProfile = await loadUserProfile();
    const currentDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const contextType = channel === "main" ? "the main chat" : "a private conversation";

    const systemPrompt = `You are ${agentName}. Your identity, personality, knowledge, tone, and behavior are defined EXCLUSIVELY by the attached files below. Follow them strictly.
${craft}
${personality}

---
[SYSTEM CONTEXT — Do not modify behavior, only environment info]
- Current date: ${currentDate}
- Conversation channel: ${contextType}
- If the user only greets, introduce yourself briefly according to your soul.
- If there is a direct question or task, answer without greeting first.${userProfile}`;

    // Tools: all natives/my_addons + MCP tools (same contract as worker-coder)
    const nativeState = JSON.parse(getGlobalConfig("native_addons_state", "{}"));
    const mcpServersConfigStr = getGlobalConfig("mcp_servers_config", '{"mcpServers":{}}');
    if (mcpServersConfigStr !== lastMcpConfigStr) {
      console.log(`[${consumerName}] MCP config changed — reconnecting servers...`);
      try {
        await globalRegistry.mcpManager.closeAll();
        await withTimeout(globalRegistry.initializeMcp(JSON.parse(mcpServersConfigStr)), 15_000, "MCP init");
      } catch (mcpErr: any) {
        console.error(`[${consumerName}] MCP init failed: ${mcpErr.message}`);
      }
      lastMcpConfigStr = mcpServersConfigStr;
    }

    // MCP tools pass if the chat UI enabled the server (enabledMcpServers) or,
    // failing that, if the agent's tools.md mentions the server/tool.
    const enabledMcpServers = (data.enabledMcpServers as string[]) || [];
    const agentRequestedTools = (personalityFiles[3] || "")
      .split("\n").map((l: string) => l.trim())
      .filter((l: string) => l.startsWith("-"))
      .map((l: string) => l.substring(1).trim());
    // Strict per-agent gating: a tool (native or MCP) runs only if this agent's
    // tools.md names it. Identical rule across all workers (see registry).
    const allowedTools = globalRegistry.resolveAllowedToolNames(agentRequestedTools, enabledMcpServers);
    // Usage tracking: the sink collects every tool call this turn; flushed to DB
    // after the LLM finishes so we can report what each agent actually uses.
    const toolUsageLog: { toolName: string; source: string; status: string }[] = [];
    const usageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error') => { toolUsageLog.push({ toolName, source, status }); };
    // Bind the calling agent's identity so identity-aware tools (`remember`,
    // `recall`) act on the right agent without trusting model input.
    const toolContext = {
      agentId,
      searchPastTasks: (query: string, limit?: number) => searchAgentTasks(sqliteClient, agentId, query, limit),
    };
    const aiTools = globalRegistry.getAiSdkTools(allowedTools, nativeState, usageSink, toolContext);
    const rawTools = globalRegistry.getRawTools(allowedTools, nativeState, usageSink, toolContext);

    const historyRows = await (db as any).select()
      .from(tasks)
      .where(and(eq(tasks.channel, channel), eq(tasks.status, "completed")))
      .orderBy(desc(tasks.createdAt))
      .limit(10);
    const history = historyRows.reverse().flatMap((t: any) => {
      const assistantText = t.resultMeta?.text || t.resultMeta?.preview || "";
      return [
        { role: "user", content: t.prompt },
        { role: "assistant", content: assistantText },
      ];
    }).filter((msg: any) => msg.content);

    // For a cron-fired task, tell the model what previous runs of this same cron
    // already delivered so it reports only what is new (no duplicate news).
    const cronDedup = await buildCronDedupContext(db, taskId);

    console.log(`[${consumerName}] Processing task ${taskId} for agent ${agentId} (${llmConfig.provider}:${llmConfig.model})...`);
    const { text, usage, success, error } = await withTimeout(
      llmGenerateText(llmConfig, [...history, await buildUserMessage(userPrompt, rootDir)], systemPrompt + cronDedup, aiTools, rawTools),
      llmConfig.provider === "local" ? 300_000 : 120_000,
      `LLM call`
    );

    // Persist tool usage for this task (best-effort; never break processing).
    if (toolUsageLog.length) {
      try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
      catch (e: any) { console.warn(`[${consumerName}] tool usage tracking failed: ${e?.message ?? e}`); }
    }

    const resultRef = await writeLocalResult(taskId, {
      taskId,
      agentId,
      createdAt: new Date().toISOString(),
      summary: success ? "Task completed successfully." : "Error processing task.",
      raw: text || error || "No response.",
    });

    const generated = buildEnvelope({
      id: randomUUID(),
      type: "agent.result_generated",
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: consumerName,
      subject: { entity: "task", id: taskId },
      trace: { traceId: envlp.trace?.traceId ?? envlp.id, causationId: envlp.id },
      data: {
        taskId,
        agentId,
        resultRef,
        tokensUsed: usage?.totalTokens ?? 0,
        durationMs: Date.now() - started,
        preview: (text || error || "No response.").slice(0, 2000),
      },
    });
    await publishJson(js, subjectForType(generated.type), generated);

    await (db as any).update(tasks)
      .set({
        status: "completed",
        resultMeta: { text, usage, success, error, modelUsed: llmConfig.model },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    console.log(`[${consumerName}] Task ${taskId} completed.`);
    m.ack();
  } catch (err: any) {
    console.error(`[${consumerName}] Error processing task ${taskId ?? "(unknown)"}:`, err);
    if (taskId) {
      // Emit task.failed so subscribers (e.g. the Telegram bot) can notify on
      // cron failures. Best-effort: publishing must never break the ack.
      try {
        const failed = buildEnvelope({
          id: randomUUID(),
          type: "task.failed",
          version: 1,
          occurredAt: new Date().toISOString(),
          producer: consumerName,
          subject: { entity: "task", id: taskId },
          data: {
            taskId,
            error: String(err?.message ?? err ?? "unknown error").slice(0, 2000),
            durationMs: Date.now() - started,
          },
        });
        await publishJson(js, subjectForType(failed.type), failed);
      } catch (e) { console.error(`[${consumerName}] failed to publish task.failed`, e); }
      try {
        await (db as any).update(tasks).set({ status: "failed", updatedAt: new Date() }).where(eq(tasks.id, taskId));
      } catch { /* ignore */ }
    }
    m.ack();
  }
}

process.on("SIGINT", () => {
  console.log(`[${consumerName}] Shutting down...`);
  process.exit(0);
});

// Local LLM model routing fix applied - 2026-05-04
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createWriteStream, mkdirSync } from "node:fs";

import { loadEnv, envFile, dataRoot, agentsDir, logsDir, usersDir, resultsDir, craftDir, readLocalLlmEnv } from "@hydraops/config";

loadDotenv({ path: envFile });

import { createDb, events, outbox, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage, buildCronDedupContext } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType } from "@hydraops/nats";
import { eq, and, desc } from "drizzle-orm";
import { generateText as llmGenerateText, resolveLLMConfig, buildUserMessage } from "@hydraops/llm";
import { createRegistry } from "@hydraops/addons";

const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "worker-coder" });
const consumerName = env.SERVICE_NAME;

// --- FILE LOGGING SETUP ---
try { mkdirSync(logsDir, { recursive: true }); } catch (e) {}
const logFile = path.join(logsDir, `${consumerName}.log`);
const logStream = createWriteStream(logFile, { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;

// A broken stdout/stderr pipe (EPIPE) — e.g. the supervisor closing our output —
// must never surface as an uncaughtException. If it did, the handler below would
// log via console.error, whose own write would EPIPE again and recurse forever,
// filling the disk with the same error (this once wrote a 194 GB log). Swallow
// stream errors so a dead pipe stays harmless.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let isLogging = false;
console.log = (...args: any[]) => {
  if (isLogging) {
    originalLog(...args);
    return;
  }
  isLogging = true;
  try {
    const msg = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    logStream.write(msg);
  } catch (e) {
    try { originalError("Failed to write to log stream:", e); } catch {}
  } finally {
    // Guard the passthrough: a throwing console write must not escape and loop.
    try { originalLog(...args); } catch {}
    isLogging = false;
  }
};

let isLoggingError = false;
console.error = (...args: any[]) => {
  if (isLoggingError || isLogging) {
    originalError(...args);
    return;
  }
  isLoggingError = true;
  try {
    const msg = `[${new Date().toISOString()}] ERROR: ${args.join(' ')}\n`;
    logStream.write(msg);
  } catch (e) {
    try { originalError("Failed to write to log stream (error):", e); } catch {}
  } finally {
    // Guard the passthrough: a throwing console write must not escape and loop.
    try { originalError(...args); } catch {}
    isLoggingError = false;
  }
};
// ---------------------------
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE') return; // dead output pipe — ignore, never re-log
  console.error(`[worker-coder] CRITICAL UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason: any) => {
  if (reason?.code === 'EPIPE') return;
  console.error(`[worker-coder] CRITICAL UNHANDLED REJECTION: ${reason?.message || reason}\n${reason?.stack || ''}`);
});

const { db, pool } = createDb(env.DATABASE_URL);
const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);
const js = await getJs(nc);

console.log(`[worker-coder] listening for agent.task_assigned on ${env.NATS_URL}`);

// --- TOOL REGISTRY & MCP SETUP ---
const globalRegistry = await createRegistry();
let lastMcpConfigStr = "";

// --- HEARTBEAT ---
async function sendHeartbeat() {
  try {
    const agentDirs = (await import("node:fs/promises")).readdir(agentsDir)
      .catch(() => [] as string[]);
    const dirs = await agentDirs;
    for (const agentId of dirs) {
      if (typeof agentId !== 'string' || agentId.startsWith('.')) continue;
      const existing = await (db as any).select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
      if (existing.length > 0 && existing[0].workerType === 'coder') {
        await (db as any).update(agentConfigs)
          .set({ lastHeartbeat: new Date() })
          .where(eq(agentConfigs.agentId, agentId))
          .run();
      }
    }

    // Service heartbeat
    try {
      await (db as any).insert(workerStatus)
        .values({ workerId: 'worker-coder', status: 'online', lastHeartbeat: new Date(), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: workerStatus.workerId,
          set: { status: 'online', lastHeartbeat: new Date(), updatedAt: new Date() }
        })
        .run();
    } catch (e) { /* silent */ }
    // Sync MCP Status
    try {
      if (globalRegistry) {
        const statuses = globalRegistry.getServerStatuses();
        if (statuses && statuses.length > 0) {
          // Per-worker key: all workers report MCP status and would otherwise overwrite each other
          await (db as any).insert(systemConfigs)
            .values({ key: `mcp_servers_status:${consumerName}`, value: JSON.stringify(statuses), updatedAt: new Date() })
            .onConflictDoUpdate({
              target: systemConfigs.key,
              set: { value: JSON.stringify(statuses), updatedAt: new Date() }
            })
            .run();
        }
      }
    } catch (e) { console.error("[worker-coder] MCP status sync error", e); }
  } catch (e) { /* silent */ }
}
sendHeartbeat();
setInterval(sendHeartbeat, 20_000);

// [CRAFT] — el oficio del tipo de worker (craft/coder.md): la teoría del rol,
// compartida por todos sus agentes. Leído por tarea, como el perfil, para
// poder editarlo en caliente; si falta, el prompt queda como antes.
async function loadCraft(): Promise<string> {
  try {
    const text = (await readFile(path.join(craftDir, "coder.md"), "utf-8")).trim();
    if (!text) return "";
    return `\n[CRAFT — the trade you practice. The agent files below define WHO you are; this defines the profession you bring to every task]\n${text}\n`;
  } catch {
    return "";
  }
}
loadCraft().then((c) => console.log(`[worker-coder] craft ${c ? "loaded (craft/coder.md)" : "missing — running without trade knowledge"}`));

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

async function writeLocalResult(taskId: string, payload: unknown) {
  const dir = path.join(resultsDir, taskId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "result.json");
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return `results/${taskId}/result.json`;
}

// --- TIMEOUT HELPER ---
function withWorkerTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[worker-coder] Timeout of ${ms}ms reached: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

import { AckPolicy } from "nats";

const sub = await js.pullSubscribe(subjectForType("agent.task_assigned"), {
  stream: "EVENTS",
  config: {
    durable_name: "worker_coder_task_assigned",
    ack_policy: AckPolicy.Explicit,
  },
});

sub.pull({ batch: 1, expires: 1000 });
setInterval(() => sub.pull({ batch: 1, expires: 1000 }), 1000);

for await (const m of sub) {
  const started = Date.now();
  let taskId: string | undefined;
  try {
    const raw = JSON.parse(new TextDecoder().decode(m.data));
    const envlp = parseEnvelope(raw);

    const inserted = await db
      .insert(processedEvents)
      .values({ consumerName, eventId: envlp.id })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });

    if (inserted.length === 0) {
      m.ack();
      continue;
    }

    taskId = (envlp.data as any).taskId as string;
    const agentId = (envlp.data as any).agentId as string;
    const channel = (envlp.data as any).channel as string || 'main';
    const workerType = (envlp.data as any).workerType as string;
    
    // If the task is not for this workerType, ignore it
    if (workerType && workerType !== 'coder') {
      m.ack();
      continue;
    }

    // Get complete task from DB to ensure we have the correct prompt
    const taskRows = await (db as any).select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const task = taskRows[0];
    
    // Priority: 1. Prompt from event, 2. Prompt from DB
    const userPrompt = (envlp.data as any).prompt as string || task?.prompt || '';
    
    // If no prompt from any source, something went wrong
    if (!userPrompt) {
      console.warn(`[worker-coder] No prompt found for task ${taskId}. Aborting.`);
      m.ack();
      continue;
    }

    const agentName = task?.assignedAgent || agentId || 'Agent';

    // Consult DB to respect the model chosen in UI for this agent.
    // "Tipo" (graphicEngine) overrides when set; 'auto' → agent model → global default.
    const cfgRows = await (db as any).select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
    const engineOverride = cfgRows[0]?.graphicEngine && cfgRows[0].graphicEngine !== "auto" ? cfgRows[0].graphicEngine : null;
    const selectedModel = engineOverride || cfgRows[0]?.model || process.env.DEFAULT_MODEL || "";

    if (!selectedModel) {
      const errorMsg = "No hay modelo. Elige uno en Configuración → Modelo por defecto, o asígnaselo al agente.";
      console.error(`[worker-coder] ERROR: ${errorMsg}`);
    }

    // --- DYNAMIC GLOBAL CONFIG LOAD FROM DB ---
    const globalConfigs = await (db as any).select().from(systemConfigs);
    // El LLM local se relee del .env en cada tarea. Es su única fuente (la API
    // lo borra de system_configs a propósito) y el .env solo se carga al
    // arrancar, así que sin esto cambiar de servidor local no surtía efecto
    // hasta reiniciar la aplicación entera.
    const localLlm = readLocalLlmEnv();
    const getGlobalConfig = (key: string, defaultValue: string) => {
      if (key in localLlm) return localLlm[key] || defaultValue;
      const found = globalConfigs.find((c: any) => c.key === key);
      return found ? found.value : (process.env[key] || defaultValue);
    };

    console.log(`[worker-coder] Resolving LLM config for model: ${selectedModel}`);
    let llmConfig = resolveLLMConfig(selectedModel, getGlobalConfig);
    if (llmConfig.provider === 'leonardo') {
        console.warn(`[worker-coder] Model ${selectedModel} is an image provider. Falling back to default text model.`);
        llmConfig = resolveLLMConfig(process.env.DEFAULT_MODEL || "", getGlobalConfig);
    }
    console.log(`[worker-coder] Resolved config: ${llmConfig.provider} at ${llmConfig.baseURL || 'default'}`);

    // Loading agent's 6 configuration files
    const fileTypes = ['agent', 'soul', 'skill', 'tools', 'memory', 'heartbeat'];
    let agentPersonalityContext = "";
    let fileContents: string[] = [];
    
    console.log(`[worker-coder] Loading personality files for ${agentId}...`);
    try {
      console.log(`[worker-coder] Loading personality from: ${agentsDir}/${agentId}`);
      fileContents = await Promise.all(
        fileTypes.map(async type => {
          const filePath = path.join(agentsDir, agentId, `${agentId}.${type}.md`);
          console.log(`[worker-coder] Reading file: ${filePath}`);
          try {
            const content = await readFile(filePath, "utf-8");
            console.log(`[worker-coder] File read SUCCESS: ${type}`);
            return content;
          } catch (e) {
            console.log(`[worker-coder] File read FAIL (expected if missing): ${type}`);
            return "";
          }
        })
      );
      console.log(`[worker-coder] All personality files read.`);
      console.log(`[worker-coder] Files loaded for ${agentId}`);

      agentPersonalityContext = fileContents
        .filter(content => content.trim().length > 0)
        .map((content, i) => `\n--- AGENT ${fileTypes[i].toUpperCase()} ---\n${content}`)
        .join("\n");

    } catch (e) {
      console.warn(`[worker-coder] Error loading complete configuration for ${agentId}`);
    }

    const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const contextType = channel === 'main' ? 'the main chat' : 'a private conversation';
    const craft = await loadCraft();
    const userProfile = await loadUserProfile();

    const systemPrompt = `You are ${agentName}. Your identity, personality, knowledge, tone, and behavior are defined EXCLUSIVELY by the attached files below. Follow them strictly.
${craft}
${agentPersonalityContext}

---
[SYSTEM CONTEXT — Do not modify behavior, only environment info]
- Current date: ${currentDate}
- Conversation channel: ${contextType}
- If the user only greets, introduce yourself briefly according to your soul.
- If there is a direct question or task, answer without greeting first.${userProfile}`;

    console.log(`[worker-coder] Processing task ${taskId} for agent ${agentId}...`);
    
    // --- MCP & SYSTEM TOOLS ---
    const nativeAddonsStateStr = getGlobalConfig('native_addons_state', '{}');
    const mcpServersConfigStr = getGlobalConfig('mcp_servers_config', '{"mcpServers":{}}');
    
    if (mcpServersConfigStr !== lastMcpConfigStr) {
      console.log(`[worker-coder] Detected change in MCP config. Reconnecting servers...`);
      const mcpConfig = JSON.parse(mcpServersConfigStr);
      try {
        await globalRegistry.mcpManager.closeAll();
        await withWorkerTimeout(globalRegistry.initializeMcp(mcpConfig), 15_000, 'MCP init');
        console.log(`[worker-coder] MCP initialized correctly (non-blocking).`);
      } catch (mcpErr: any) {
        console.error(`[worker-coder] MCP init failed: ${mcpErr.message}`);
      }
      lastMcpConfigStr = mcpServersConfigStr;
    }
    
    console.log(`[worker-coder] Getting tools for agent ${agentId}...`);
    const globalNativeState = JSON.parse(nativeAddonsStateStr);
    
    const enabledMcpServers = (envlp.data as any).enabledMcpServers as string[] || [];
    
    // Parse tools from tools.md
    const toolsFileContent = fileContents[3] || "";
    const agentRequestedTools = toolsFileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('-'))
      .map(line => line.substring(1).trim());

    console.log(`[worker-coder] Agent ${agentId} requested tools: ${agentRequestedTools.join(', ')}`);
    
    // Strict per-agent gating: a tool (native or MCP) runs only if this agent's
    // tools.md names it. Identical rule across all workers (see registry).
    const allowedTools = globalRegistry.resolveAllowedToolNames(agentRequestedTools, enabledMcpServers);

    console.log(`[worker-coder] Enabled MCP servers from chat: [${enabledMcpServers.join(', ')}] → ${allowedTools.length} tools total`);

    // Usage tracking: the sink collects every tool call this turn; flushed to DB
    // after the LLM finishes so we can report what each agent actually uses.
    const toolUsageLog: { toolName: string; source: string; status: string }[] = [];
    const usageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error') => { toolUsageLog.push({ toolName, source, status }); };
    // Bind the calling agent's identity so identity-aware tools (e.g.
    // `remember`) act on the right agent without trusting model input.
    const toolContext = { agentId };
    const aiTools = globalRegistry.getAiSdkTools(allowedTools, globalNativeState, usageSink, toolContext);
    const rawTools = globalRegistry.getRawTools(allowedTools, globalNativeState, usageSink, toolContext);

    // Fetch conversation history (last 10 completed tasks in this channel)
    const historyRows = await (db as any).select()
      .from(tasks)
      .where(and(eq(tasks.channel, channel), eq(tasks.status, 'completed')))
      .orderBy(desc(tasks.createdAt))
      .limit(10);
    
    const history = historyRows.reverse().map((t: any) => {
      const assistantText = t.resultMeta?.text || t.resultMeta?.preview || t.resultMeta?.raw || '';
      return [
        { role: 'user', content: t.prompt },
        { role: 'assistant', content: assistantText }
      ];
    }).flat().filter((m: any) => m.content);

    const finalMessages = [
      ...history,
      await buildUserMessage(userPrompt, dataRoot)
    ];

    // For a cron-fired task, append what previous runs of this same cron already
    // delivered so the model reports only what is new (no duplicate news).
    const cronDedup = await buildCronDedupContext(db, taskId);

    console.log(`[worker-coder] [LLM] Calling generateText with ${llmConfig.provider}:${llmConfig.model}...`);
    const { text, usage, success, error } = await withWorkerTimeout(
      llmGenerateText(
        llmConfig,
        finalMessages,
        systemPrompt + cronDedup,
        aiTools,
        rawTools
      ),
      llmConfig.provider === 'local' ? 300_000 : 120_000,
      `LLM call (${llmConfig.provider}:${llmConfig.model})`
    );
    console.log(`[worker-coder] [LLM] Call finished. Success: ${success}`);

    // Persist tool usage for this task (best-effort; never break processing).
    if (toolUsageLog.length) {
      try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
      catch (e: any) { console.warn(`[worker-coder] tool usage tracking failed: ${e?.message ?? e}`); }
    }

    if (success) {
      console.log(`[worker-coder] DEBUG -> Response: "${text}"`);
    }

    const rawResult = {
      taskId,
      agentId,
      createdAt: new Date().toISOString(),
      summary: success ? "Task completed successfully." : "Error processing task.",
      raw: text || error || "No response.",
      artifacts: [{ path: "output.txt", contentType: "text/plain" }],
    };

    const resultRef = await writeLocalResult(taskId, rawResult);
    const durationMs = Date.now() - started;
    const tokensUsed = usage ? usage.totalTokens : 0;

    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    const generated = buildEnvelope({
      id: eventId,
      type: "agent.result_generated",
      version: 1,
      occurredAt,
      producer: consumerName,
      subject: { entity: "task", id: taskId },
      trace: { traceId: envlp.trace?.traceId ?? envlp.id, causationId: envlp.id },
      data: {
        taskId,
        agentId,
        resultRef,
        tokensUsed,
        durationMs,
        preview: (text || error || "No response.").slice(0, 2000),
      }
    });

    console.log(`[worker-coder] Generated result event ${eventId}`);
    await publishJson(js, subjectForType(generated.type), generated);

    await (db as any).update(tasks)
      .set({ 
        status: "completed",
        resultMeta: { text, usage, success, error, modelUsed: llmConfig.model },
        updatedAt: new Date()
      })
      .where(eq(tasks.id, taskId));

    console.log(`[worker-coder] Task ${taskId} marked as completed.`);
    m.ack();
  } catch (err: any) {
    console.error(`[worker-coder] Unhandled error processing task ${taskId ?? "(unknown)"}:`, err);
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
      } catch (e) { console.error(`[worker-coder] failed to publish task.failed`, e); }
      try {
        await (db as any).update(tasks)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(tasks.id, taskId));
      } catch { /* ignore */ }
    }
    m.ack();
  }
}

process.on("SIGINT", () => {
  console.log(`[worker-coder] Shutting down...`);
  process.exit(0);
});

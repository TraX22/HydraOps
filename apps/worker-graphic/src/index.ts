// worker-graphic — agents with workerType 'graphic'.
// Decides chat-vs-draw per prompt: drawing requests go through generateImage
// (engine from agentConfigs.graphicEngine), everything else is a normal
// personality-driven text reply. Images are saved under the ROOT storage/
// dir so the API's /storage static route can serve them to the chat.
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnv, envFile, dataRoot, agentsDir, storageDir, logsDir, usersDir, craftDir, readLocalLlmEnv } from "@hydraops/config";

loadDotenv({ path: envFile });

import { createDb, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType } from "@hydraops/nats";
import { and, desc, eq } from "drizzle-orm";
import { generateText as llmGenerateText, generateImage, resolveLLMConfig, buildUserMessage } from "@hydraops/llm";
import { createRegistry } from "@hydraops/addons";
import { AckPolicy } from "nats";

const WORKER_TYPE = "graphic";
const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "worker-graphic" });
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

const { db } = createDb(env.DATABASE_URL);
const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);
const js = await getJs(nc);

console.log(`[${consumerName}] listening for agent.task_assigned (workerType=${WORKER_TYPE}) on ${env.NATS_URL}`);

const globalRegistry = await createRegistry();
let lastMcpConfigStr = "";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[${consumerName}] Timeout of ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

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

// Chat-vs-draw heuristic: explicit drawing verbs / image nouns → draw
const DRAW_PATTERNS = [
  /\b(dibuja|dibujame|dibújame|pinta|ilustra|genera|crea|hazme|haz)\b.*\b(imagen|dibujo|ilustraci[oó]n|foto|retrato|logo|póster|poster|wallpaper|avatar)\b/i,
  /\b(draw|paint|illustrate|generate|create|make)\b.*\b(image|picture|drawing|illustration|photo|portrait|logo|poster|wallpaper|avatar)\b/i,
  /\bimagen de\b/i,
  /\bimage of\b/i,
];

function wantsDrawing(prompt: string): boolean {
  return DRAW_PATTERNS.some((re) => re.test(prompt));
}

// agentConfigs.resolution (aspect) → concrete image dimensions
const IMAGE_SIZES: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
};

function imageSize(resolution?: string | null): [number, number] {
  return IMAGE_SIZES[resolution ?? ""] ?? [1024, 1024];
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

const sub = await js.pullSubscribe(subjectForType("agent.task_assigned"), {
  stream: "EVENTS",
  config: {
    durable_name: "worker_graphic_task_assigned",
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
      m.ack();
      continue;
    }

    const cfgRows = await (db as any).select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
    const agentCfg = cfgRows[0] ?? {};

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

    let resultMeta: Record<string, unknown>;
    let previewText: string;

    if (wantsDrawing(userPrompt)) {
      // --- DRAW PATH ---
      const engine = agentCfg.graphicEngine && agentCfg.graphicEngine !== "auto"
        ? agentCfg.graphicEngine
        : agentCfg.model || process.env.DEFAULT_IMAGE_MODEL || "imagen-3.0-generate-002";
      const imgConfig = resolveLLMConfig(engine, getGlobalConfig);
      const [imgWidth, imgHeight] = imageSize(agentCfg.resolution);
      console.log(`[${consumerName}] 🎨 Drawing task ${taskId} with ${imgConfig.provider}:${imgConfig.model} (${imgWidth}x${imgHeight})...`);

      const img = await generateImage(imgConfig, userPrompt, imgWidth, imgHeight);
      if (img.success && img.base64) {
        const format = (agentCfg.graphicFormat || "png").replace(/[^a-z]/gi, "") || "png";
        const dir = path.join(storageDir, "results", taskId);
        await mkdir(dir, { recursive: true });
        const fileName = `image.${format}`;
        await writeFile(path.join(dir, fileName), Buffer.from(img.base64, "base64"));
        const relPath = `results/${taskId}/${fileName}`;
        previewText = "🖼️ Imagen generada.";
        resultMeta = {
          text: previewText,
          success: true,
          imagePath: relPath,
          imageUrl: relPath,
          sourceUrl: img.url ?? null,
          modelUsed: imgConfig.model,
        };
      } else {
        previewText = `⚠️ Error generando imagen: ${img.error}`;
        resultMeta = { text: "", success: false, error: img.error, modelUsed: imgConfig.model };
      }
    } else {
      // --- CHAT PATH (personality-driven text reply) ---
      const textModel = agentCfg.model || process.env.DEFAULT_MODEL || "";
      if (!textModel) {
        console.error("[worker-graphic] ERROR: no hay modelo de texto. Elige uno en Configuración → Modelo por defecto, o asígnaselo al agente.");
      }
      let llmConfig = resolveLLMConfig(textModel, getGlobalConfig);
      if (llmConfig.provider === "leonardo") {
        llmConfig = resolveLLMConfig(process.env.DEFAULT_MODEL || "", getGlobalConfig);
      }
      const { context: personality, files: personalityFiles } = await loadPersonality(agentId);
      const craft = await loadCraft();
      const userProfile = await loadUserProfile();
      const currentDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const contextType = channel === "main" ? "the main chat" : "a private conversation";
      const systemPrompt = `You are ${agentId}. Your identity is defined EXCLUSIVELY by the attached files. You are a graphic/visual agent: if the user asks you to draw something, tell them how to phrase it (e.g. "dibuja una imagen de...").
${craft}
${personality}

---
[SYSTEM CONTEXT — Do not modify behavior, only environment info]
- Current date: ${currentDate}
- Conversation channel: ${contextType}
- If the user only greets, introduce yourself briefly according to your soul.
- If there is a direct question or task, answer without greeting first.${userProfile}`;

      // Same tool set as worker-general: natives/my_addons + MCP tools
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
      // Usage tracking: the sink collects every tool call this turn; flushed to
      // DB after the LLM finishes so we can report what each agent actually uses.
      const toolUsageLog: { toolName: string; source: string; status: string }[] = [];
      const usageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error') => { toolUsageLog.push({ toolName, source, status }); };
      const aiTools = globalRegistry.getAiSdkTools(allowedTools, nativeState, usageSink);
      const rawTools = globalRegistry.getRawTools(allowedTools, nativeState, usageSink);

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

      console.log(`[${consumerName}] 💬 Chat task ${taskId} with ${llmConfig.provider}:${llmConfig.model}...`);
      const { text, usage, success, error } = await llmGenerateText(
        llmConfig,
        [...history, await buildUserMessage(userPrompt, rootDir)],
        systemPrompt,
        aiTools,
        rawTools
      );
      previewText = text || error || "No response.";
      resultMeta = { text, usage, success, error, modelUsed: llmConfig.model };

      // Persist tool usage for this task (best-effort; never break processing).
      if (toolUsageLog.length) {
        try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
        catch (e: any) { console.warn(`[${consumerName}] tool usage tracking failed: ${e?.message ?? e}`); }
      }
    }

    const dir = path.join(storageDir, "results", taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify({ taskId, agentId, createdAt: new Date().toISOString(), ...resultMeta }, null, 2),
      "utf-8"
    );

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
        resultRef: `results/${taskId}/result.json`,
        tokensUsed: (resultMeta as any).usage?.totalTokens ?? 0,
        durationMs: Date.now() - started,
        preview: previewText.slice(0, 2000),
      },
    });
    await publishJson(js, subjectForType(generated.type), generated);

    await (db as any).update(tasks)
      .set({
        status: "completed",
        resultRef: `results/${taskId}/result.json`,
        resultMeta,
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

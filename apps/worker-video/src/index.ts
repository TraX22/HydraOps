// worker-video — agents with workerType 'video'.
// Decides chat-vs-video per prompt: explicit video requests go through
// generateVideo (Leonardo Motion 2.0 text-to-video → MP4), everything else is
// a normal personality-driven text reply with the agent's assigned model.
// The MP4 is downloaded into the ROOT storage/ dir so the API's /storage
// static route can serve it in the chat.
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnv, envFile, dataRoot, agentsDir, storageDir, logsDir, usersDir, craftDir, readLocalLlmEnv } from "@hydraops/config";

loadDotenv({ path: envFile });

import { createDb, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage, loadRecentChannelHistory, searchAgentTasks } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType } from "@hydraops/nats";
import { and, desc, eq } from "drizzle-orm";
import { generateText as llmGenerateText, generateVideo, resolveLLMConfig, buildUserMessage, GROK_VIDEO_ASPECTS, isGrokVideoEngine } from "@hydraops/llm";
import { createRegistry } from "@hydraops/addons";
import { tool } from "ai";
import { z } from "zod";
import { AckPolicy } from "nats";

const WORKER_TYPE = "video";
const env = loadEnv({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? "worker-video" });
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

// Chat-vs-video heuristic: explicit video verbs / nouns → generate video
const VIDEO_PATTERNS = [
  /\b(genera|crea|haz|hazme|anima|graba|produce)\b.*\b(video|v[ií]deo|animaci[oó]n|clip|corto)\b/i,
  /\b(generate|create|make|animate|produce|render)\b.*\b(video|animation|clip)\b/i,
  /\bv[ií]deo de\b/i,
  /\bvideo of\b/i,
];

function wantsVideo(prompt: string): boolean {
  return VIDEO_PATTERNS.some((re) => re.test(prompt));
}

// agentConfigs.resolution (aspect) → concrete video dimensions. Leonardo's
// RESOLUTION_480 tier only accepts 832x480, 480x832, 512x768 and 576x720
// (anything else is rejected), so aspects without an exact match map to the
// closest valid one. Veo only reads the orientation (16:9 / 9:16) from this.
const VIDEO_SIZES: Record<string, [number, number]> = {
  "1:1": [832, 480],
  "16:9": [832, 480],
  "9:16": [480, 832],
  "4:3": [832, 480],
  "3:4": [576, 720],
  "2:3": [512, 768],
};

function videoSize(resolution?: string | null): [number, number] {
  return VIDEO_SIZES[resolution ?? ""] ?? [832, 480];
}

// The video engine this agent renders with. generateVideo (@hydraops/llm)
// speaks Google (Veo), xAI (Grok Imagine) and Leonardo, so anything else
// picked in the Agents view falls back to Leonardo Motion — loudly, so it
// shows in the logs instead of silently ignoring the user's choice.
function resolveVideoEngine(
  agentCfg: any,
  getGlobalConfig: (key: string, defaultValue: string) => string,
): ReturnType<typeof resolveLLMConfig> {
  const picked = agentCfg.graphicEngine && agentCfg.graphicEngine !== "auto" ? agentCfg.graphicEngine : "leonardo-ai";
  const cfg = resolveLLMConfig(picked, getGlobalConfig);
  if (cfg.provider === "leonardo" || cfg.provider === "google" || isGrokVideoEngine(cfg)) return cfg;
  console.warn(`[${consumerName}] video engine "${picked}" is not supported by generateVideo (Google/xAI/Leonardo only) — falling back to Leonardo`);
  return resolveLLMConfig("leonardo-ai", getGlobalConfig);
}

// Render with the agent's engine and keep a local MP4 copy where the chat
// serves it from (storage/results/<task>/video.mp4); the remote URL stays as
// the fallback if the download fails.
async function renderToStorage(
  taskId: string,
  agentCfg: any,
  getGlobalConfig: (key: string, defaultValue: string) => string,
  prompt: string,
): Promise<{ videoUrl?: string; relPath: string | null; sourceUrl: string | null; engine: string; error?: string }> {
  const videoConfig = resolveVideoEngine(agentCfg, getGlobalConfig);
  const [vidWidth, vidHeight] = videoSize(agentCfg.resolution);
  const nativeAspects = isGrokVideoEngine(videoConfig) ? GROK_VIDEO_ASPECTS
    : videoConfig.provider === "google" ? ["16:9", "9:16"]
    : ["16:9", "9:16", "3:4", "2:3"];
  const aspect = agentCfg.resolution && agentCfg.resolution !== "auto" ? String(agentCfg.resolution) : null;
  if (aspect && !nativeAspects.includes(aspect)) {
    console.warn(`[${consumerName}] aspect ${aspect} is not available on ${videoConfig.provider}; rendering ${vidWidth}x${vidHeight} instead`);
  }
  console.log(`[${consumerName}] 🎬 Video task ${taskId} with ${videoConfig.provider}:${videoConfig.model} (${aspect ?? "auto"}, ${vidWidth}x${vidHeight})...`);
  const video = await generateVideo(videoConfig, prompt, vidWidth, vidHeight, aspect);
  if (!video.success || !video.url) {
    return { relPath: null, sourceUrl: null, engine: videoConfig.model, error: video.error || "unknown error" };
  }
  const dir = path.join(storageDir, "results", taskId);
  await mkdir(dir, { recursive: true });
  let relPath: string | null = null;
  try {
    const res = await fetch(video.url);
    if (res.ok) {
      await writeFile(path.join(dir, "video.mp4"), Buffer.from(await res.arrayBuffer()));
      relPath = `results/${taskId}/video.mp4`;
    }
  } catch (dlErr: any) {
    console.warn(`[${consumerName}] Could not download MP4, keeping remote URL only: ${dlErr.message}`);
  }
  return { videoUrl: relPath ?? video.url, relPath, sourceUrl: video.url, engine: videoConfig.model };
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
    durable_name: "worker_video_task_assigned",
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

    // One path for everything: the agent's LLM decides when to render by
    // calling the generate_video tool and writes the engine prompt itself
    // (shot, motion, light — that IS its craft). Before, a keyword regex sent
    // matching requests straight to the engine with the raw user text and
    // everything else got a text-only reply telling the user to rephrase.
    // The regex now only reinforces explicit asks (see below).
    const explicitVideo = wantsVideo(userPrompt);
    const textModel = agentCfg.model || process.env.DEFAULT_MODEL || "";
    if (!textModel) {
      console.error("[worker-video] ERROR: no text model configured. Pick one in Config → Default model, or assign one to the agent.");
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
    const systemPrompt = `You are ${agentId}. Your identity is defined EXCLUSIVELY by the attached files. You are a video-generation agent with a generate_video tool: whenever the user wants a video, clip or animation — in ANY wording — say in 1-3 lines what you will shoot, then CALL generate_video with a polished English prompt (subject, action, shot, camera motion, light, look; a single beat for short clips). After it returns, reply with a short note on the result and suggested Next Steps. Never ask the user to rephrase, never say you have no video engine, never hand the user a prompt to paste elsewhere.
${craft}
${personality}

---
[SYSTEM CONTEXT — Do not modify behavior, only environment info]
- Current date: ${currentDate}
- Conversation channel: ${contextType}
- The chat renders Markdown. For diagrams or simple charts, answer with a \`\`\`mermaid fenced code block (flowchart, sequence, pie, timeline…) — it renders as a real diagram. Use Markdown tables for tabular data; avoid ASCII-art boxes.
- If the user only greets, introduce yourself briefly according to your soul.
- If there is a direct question or task, answer without greeting first.${explicitVideo ? "\n- The user explicitly asked for a video: you MUST call generate_video in this turn." : ""}${userProfile}`;

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
    // Bind the calling agent's identity so identity-aware tools (`remember`,
    // `recall`) act on the right agent without trusting model input.
    const toolContext = {
      agentId,
      searchPastTasks: (query: string, limit?: number) => searchAgentTasks(sqliteClient, agentId, query, limit),
    };
    const aiTools = globalRegistry.getAiSdkTools(allowedTools, nativeState, usageSink, toolContext);
    const rawTools = globalRegistry.getRawTools(allowedTools, nativeState, usageSink, toolContext);


    // The rendering tool. It stores the MP4 where the chat serves it from and
    // remembers what it produced so the result can carry the video; tracked in
    // tool_usage like any other tool.
    const rendered: { video: { videoUrl: string; relPath: string | null; sourceUrl: string | null; engine: string } | null; error: string | null } = { video: null, error: null };
    const render = async (prompt: string): Promise<string> => {
      const r = await renderToStorage(taskId!, agentCfg, getGlobalConfig, prompt);
      if (r.videoUrl) {
        rendered.video = { videoUrl: r.videoUrl, relPath: r.relPath, sourceUrl: r.sourceUrl, engine: r.engine };
        usageSink("generate_video", "native", "ok");
        return "Video generated and already shown to the user. Reply with a short description of the shot and suggested Next Steps; do not paste links.";
      }
      rendered.error = r.error ?? "unknown error";
      usageSink("generate_video", "native", "error");
      return `Video generation failed (${rendered.error}). Tell the user briefly and suggest retrying or changing the engine.`;
    };
    const generateVideoDescription =
      "Generate a short video with this agent's configured video engine and show it to the user in the chat. Call it whenever the user wants a video, clip or animation.";
    const generateVideoSchema = z.object({
      prompt: z.string().describe("Self-contained English video prompt: subject, action, shot type, camera motion, lighting, look. One beat for a 5-second clip."),
    });
    const toolsForModel = {
      ...(aiTools ?? {}),
      generate_video: tool({
        description: generateVideoDescription,
        inputSchema: generateVideoSchema,
        execute: ({ prompt }: { prompt: string }) => render(prompt),
      }),
    };
    const rawToolsForModel = [
      ...rawTools,
      { name: "generate_video", description: generateVideoDescription, schema: generateVideoSchema, execute: (args: any) => render(String(args?.prompt ?? "")) },
    ];

    // Last 24h of the channel; empty for cron-fired tasks (see loadRecentChannelHistory).
    const historyRows = await loadRecentChannelHistory(db, channel, taskId);
    const history = historyRows.reverse().flatMap((t: any) => {
      const assistantText = t.resultMeta?.text || t.resultMeta?.preview || "";
      return [
        { role: "user", content: t.prompt },
        { role: "assistant", content: assistantText },
      ];
    }).filter((msg: any) => msg.content);


    console.log(`[${consumerName}] 💬 Task ${taskId} with ${llmConfig.provider}:${llmConfig.model}${explicitVideo ? " (explicit video request)" : ""}...`);
    const { text, usage, success, error, errorCode } = await llmGenerateText(
      llmConfig,
      [...history, await buildUserMessage(userPrompt, rootDir)],
      systemPrompt,
      toolsForModel,
      rawToolsForModel
    );

    // Explicit request but the model never rendered (weak/local models): fall
    // back to the engine with the raw prompt, as the old video path did.
    if (explicitVideo && !rendered.video && !rendered.error) {
      const r = await renderToStorage(taskId!, agentCfg, getGlobalConfig, userPrompt);
      if (r.videoUrl) rendered.video = { videoUrl: r.videoUrl, relPath: r.relPath, sourceUrl: r.sourceUrl, engine: r.engine };
      else rendered.error = r.error ?? "unknown error";
    }

    resultMeta = { text, usage, success, error, errorCode, modelUsed: llmConfig.model };
    if (rendered.video) {
      Object.assign(resultMeta, {
        videoPath: rendered.video.relPath,
        videoUrl: rendered.video.videoUrl,
        sourceUrl: rendered.video.sourceUrl,
        videoModel: rendered.video.engine,
      });
      if (!text) resultMeta.text = "🎬 Video generado.";
    } else if (rendered.error && !text) {
      Object.assign(resultMeta, { success: false, error: rendered.error });
    }
    previewText = String(resultMeta.text || resultMeta.error || "No response.");

    // Persist tool usage for this task (best-effort; never break processing).
    if (toolUsageLog.length) {
      try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
      catch (e: any) { console.warn(`[${consumerName}] tool usage tracking failed: ${e?.message ?? e}`); }
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

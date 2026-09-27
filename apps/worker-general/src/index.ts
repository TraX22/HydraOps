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

import { createDb, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage, recordSecurityEvents, createPendingAction, loadPendingAction, finishPendingAction, buildCronDedupContext, loadRecentChannelHistory, searchAgentTasks, isTaskCancelled } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType, createCancelRegistry } from "@hydraops/nats";
import { eq, and, desc, ne } from "drizzle-orm";
import { generateText as llmGenerateText, resolveLLMConfig, buildUserMessage } from "@hydraops/llm";
import { createRegistry, createSourceCollector, historyAssistantText, createTaskSecurity, resolveSecurityMode, executeApprovedCall, EXTERNAL_CONTENT_RULE, skillsPromptSection, isValidSkillName, listInstalledSkills, createProgressTracker, planModePrompt, planFromProposal, planFromText, createPlanTools, type Plan } from "@hydraops/addons";
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
// Stop button / /cancel: aborts the task this worker is running (see createCancelRegistry).
const cancels = createCancelRegistry(nc, consumerName);

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

// onTimeout lets the caller abort the underlying work: rejecting alone leaves the
// model call running (and billing) in the background.
// How long one task may keep the model working (tool calls included). A research task
// is dozens of searches and page reads; 2 minutes cut those off and lost all the work.
// Still well under the API's 30-minute sweep of stuck tasks, and the Stop button ends
// a run early. HYDRA_LLM_TIMEOUT_MIN overrides both (minutes).
const LLM_TIMEOUT_MS = (provider: string) => {
  const override = Number(process.env.HYDRA_LLM_TIMEOUT_MIN);
  if (Number.isFinite(override) && override > 0) return Math.min(override, 25) * 60_000;
  return provider === "local" ? 15 * 60_000 : 10 * 60_000;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(new Error(`[${consumerName}] Timeout of ${ms}ms: ${label}`)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}


// --- Approved actions: run a held sensitive call as-is, without the model ---
// (see @hydraops/addons provenance.ts and approvals.ts). The approval is the user's
// decision on that one stored call; nothing is generated again.
async function readAgentToolLines(agentId: string): Promise<string[]> {
  try {
    const md = await readFile(path.join(agentsDir, agentId, `${agentId}.tools.md`), "utf-8");
    return md.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-")).map((l) => l.substring(1).trim());
  } catch { return []; }
}
async function runApprovedAction(actionId: string): Promise<void> {
  const action = await loadPendingAction(db, actionId);
  if (!action || action.status !== "approved") return;
  const globalConfigs = await (db as any).select().from(systemConfigs);
  const localLlm = readLocalLlmEnv();
  const getGlobalConfig = (key: string, defaultValue: string) => {
    if (key in localLlm) return localLlm[key] || defaultValue;
    const found = globalConfigs.find((c: any) => c.key === key);
    return found ? found.value : process.env[key] || defaultValue;
  };
  const mcpServersConfigStr = getGlobalConfig("mcp_servers_config", '{"mcpServers":{}}');
  if (mcpServersConfigStr !== lastMcpConfigStr) {
    try {
      await globalRegistry.mcpManager.closeAll();
      await withTimeout(globalRegistry.initializeMcp(JSON.parse(mcpServersConfigStr)), 15_000, "MCP init");
    } catch (mcpErr: any) {
      console.error(`[${consumerName}] MCP init failed: ${mcpErr.message}`);
    }
    lastMcpConfigStr = mcpServersConfigStr;
  }
  const agentId = String(action.agentId);
  console.log(`[${consumerName}] Running approved ${action.toolName} (${actionId}) for ${agentId}...`);
  const outcome = await executeApprovedCall(globalRegistry, {
    toolName: String(action.toolName),
    args: action.args ?? {},
    requestedTools: await readAgentToolLines(agentId),
    nativeState: JSON.parse(getGlobalConfig("native_addons_state", "{}")),
    context: {
      agentId,
      searchPastTasks: (query: string, limit?: number) => searchAgentTasks(sqliteClient, agentId, query, limit),
      // The held call came from a task that had read outside content; a replayed
      // delegate_task must hand that taint on.
      taintOrigins: () => (Array.isArray(action.origins) ? action.origins : []),
    },
  });
  await finishPendingAction(db, actionId, outcome.ok ? "executed" : "failed", outcome.result);
  console.log(`[${consumerName}] Approved ${action.toolName} (${actionId}): ${outcome.ok ? "executed" : "failed"}.`);
}
const approvalsSub = await js.pullSubscribe(subjectForType("action.approved"), {
  stream: "EVENTS",
  config: {
    durable_name: "worker_general_action_approved",
    ack_policy: AckPolicy.Explicit,
  },
});
approvalsSub.pull({ batch: 1, expires: 1000 });
setInterval(() => approvalsSub.pull({ batch: 1, expires: 1000 }), 2000);
(async () => {
  for await (const m of approvalsSub) {
    let approvedId = "";
    try {
      const envlp = parseEnvelope(JSON.parse(new TextDecoder().decode(m.data)));
      const data = envlp.data as any;
      if (data.workerType === WORKER_TYPE) {
        approvedId = String(data?.actionId ?? "");
        const inserted = await (db as any).insert(processedEvents).values({ consumerName, eventId: envlp.id })
          .onConflictDoNothing().returning({ eventId: processedEvents.eventId });
        if (inserted.length > 0) await runApprovedAction(String(data.actionId));
      }
    } catch (e: any) {
      console.error(`[${consumerName}] approved action failed: ${e?.message ?? e}`);
      if (approvedId) await finishPendingAction(db, approvedId, "failed", String(e?.message ?? e)).catch(() => {});
    }
    m.ack();
  }
})();

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
    if (taskRows[0]?.status === "cancelled") {
      console.log(`[${consumerName}] Task ${taskId} was cancelled before it started — skipped`);
      m.ack();
      continue;
    }
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
- The chat renders Markdown. For diagrams or simple charts, answer with a \`\`\`mermaid fenced code block (flowchart, sequence, pie, timeline…) — it renders as a real diagram. Use Markdown tables for tabular data; avoid ASCII-art boxes.
- If the user only greets, introduce yourself briefly according to your soul.
- You can only act through the tools listed for you. If a request needs something you have no tool for (asking another agent, sending a message, running code…), say so plainly and suggest what the user can do — never claim to have done it.
- Links: only give a URL you actually opened or saw in a tool result or in this conversation (earlier answers list their sources). Never reconstruct an address from memory, and never call one "verified" or "confirmed" unless you opened it in this turn. If you do not have the link, say so and offer to look it up.
${EXTERNAL_CONTENT_RULE}
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
    // /plan: this task only reads and proposes (see @hydraops/addons plan.ts). The
    // read-only cut of the agent's tools, plus propose_plan; the plan lands on the task.
    const planMode = taskRows[0]?.mode === "plan";
    const planSeed: Plan | null = planMode && taskRows[0]?.plan && typeof taskRows[0].plan === "object" ? (taskRows[0].plan as Plan) : null;
    const planParentRows = planSeed?.parentTaskId ? await (db as any).select({ plan: tasks.plan }).from(tasks).where(eq(tasks.id, planSeed.parentTaskId)).limit(1) : [];
    const planPrevious: Plan | null = planParentRows[0]?.plan && typeof planParentRows[0].plan === "object" ? (planParentRows[0].plan as Plan) : null;
    const planVersion = planSeed?.version ?? 1;
    const allowedToolsAll = globalRegistry.resolveAllowedToolNames(agentRequestedTools, enabledMcpServers);
    const allowedTools = planMode ? globalRegistry.readOnlyToolNames(allowedToolsAll) : allowedToolsAll;
    // Usage tracking: the sink collects every tool call this turn; flushed to DB
    // after the LLM finishes so we can report what each agent actually uses.
    const toolUsageLog: { toolName: string; source: string; status: string }[] = [];
    // Skills this task opened (skills_view), by name: stored with the result for Statistics.
    const skillsOpened = new Set<string>();
    const usageSink = (toolName: string, source: string, status: 'ok' | 'blocked' | 'error' | 'held', args?: unknown) => {
      toolUsageLog.push({ toolName, source, status });
      const skill = (args as { name?: unknown } | undefined)?.name;
      if (toolName === 'skills_view' && status === 'ok' && isValidSkillName(skill)) skillsOpened.add(skill);
    };
    // URLs the tools open or surface while answering: stored with the result, shown as
    // "Sources" and replayed in the history (see @hydraops/addons sources.ts).
    const sourceCollector = createSourceCollector();
    // Prompt-injection state of this task: set when a tool brings in third-party
    // content, which then reaches the model marked as data (see provenance.ts).
    // From then on a sensitive call is HELD for the user's approval (mode 'ask').
    // What the agent is doing, shown under the chat's typing dots (see @hydraops/addons progress.ts).
    const progress = createProgressTracker((p) => (db as any).update(tasks).set({ progress: p }).where(eq(tasks.id, taskId!)).run());
    const taskSecurity = createTaskSecurity({
      mode: resolveSecurityMode(getGlobalConfig("security_mode", "ask"), cfgRows[0]?.securityMode),
      // One image per task is bound elsewhere; a video is held (it is the costly one).
      neverHold: ["generate_image"],
      // The agent's permanent memory: an injected rule saved there would outlive the task.
      alwaysHold: ["remember"],
      // Delegated by a task that had read outside content (delegate_task passes it on).
      inherited: Array.isArray(taskRows[0]?.inheritedTaint) ? taskRows[0].inheritedTaint : undefined,
      onHold: ({ toolName, args, origins }) => createPendingAction(db, { taskId: taskId!, agentId, channel, toolName, args, origins }),
    });
    // Bind the calling agent's identity so identity-aware tools (`remember`,
    // `recall`) act on the right agent without trusting model input.
    const toolContext = {
      agentId,
      searchPastTasks: (query: string, limit?: number) => searchAgentTasks(sqliteClient, agentId, query, limit),
      // recall: a past answer written after reading outside content taints this task too.
      external: (tool: string, ref: string | undefined, content: string) => taskSecurity.external(tool, ref, content),
      // delegate_task: hand this task's taint on to the agent it delegates to.
      taintOrigins: () => taskSecurity.origins(),
    };
    // Installed skills, by name and description, for an agent that may use them (the
    // full text is opened on demand with skills_view; see @hydraops/addons skills.ts).
    const skillsSection = await skillsPromptSection(allowedTools.filter((n: string) => nativeState[n] !== false)).catch(() => "");
    const aiTools = globalRegistry.getAiSdkTools(allowedTools, nativeState, usageSink, toolContext, sourceCollector.sink, taskSecurity, progress.sink);
    const rawTools = globalRegistry.getRawTools(allowedTools, nativeState, usageSink, toolContext, sourceCollector.sink, taskSecurity, progress.sink);
    let proposedPlan: unknown = null;
    const planTools = planMode ? createPlanTools((proposal) => { proposedPlan = proposal; }) : null;
    const planSection = planMode ? planModePrompt({ toolNames: allowedTools, previous: planPrevious ?? undefined, userNotes: planPrevious ? userPrompt : undefined, version: planVersion }) : "";

    // Last 24h of the channel; empty for cron-fired tasks (see loadRecentChannelHistory).
    const historyRows = await loadRecentChannelHistory(db, channel, taskId);
    const history = historyRows.reverse().flatMap((t: any) => {
      const assistantText = historyAssistantText(t.resultMeta);
      return [
        { role: "user", content: t.prompt },
        { role: "assistant", content: assistantText },
      ];
    }).filter((msg: any) => msg.content);

    // For a cron-fired task, tell the model what previous runs of this same cron
    // already delivered so it reports only what is new (no duplicate news).
    const cronDedup = await buildCronDedupContext(db, taskId);

    console.log(`[${consumerName}] Processing task ${taskId} for agent ${agentId} (${llmConfig.provider}:${llmConfig.model})...`);
    const controller = cancels.track(taskId);
    const { text, usage, success, error, errorCode } = await withTimeout(
      llmGenerateText(llmConfig, [...history, await buildUserMessage(userPrompt, rootDir)], systemPrompt + skillsSection + planSection + cronDedup, planTools ? { ...aiTools, ...planTools.ai } : aiTools, planTools ? [...rawTools, ...planTools.raw] : rawTools, { abortSignal: controller.signal }),
      LLM_TIMEOUT_MS(llmConfig.provider),
      `LLM call`,
      () => controller.abort(new Error("LLM call timed out")),
    );

    // Persist tool usage for this task (best-effort; never break processing).
    if (toolUsageLog.length) {
      try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
      catch (e: any) { console.warn(`[${consumerName}] tool usage tracking failed: ${e?.message ?? e}`); }
    }
    if (taskSecurity.events().length) {
      try { await recordSecurityEvents(db, agentId, taskId, taskSecurity.events()); }
      catch (e: any) { console.warn(`[${consumerName}] security log failed: ${e?.message ?? e}`); }
    }

    // Cancelled while it ran: the row already says so — write nothing, publish nothing, overwrite nothing.
    if (await isTaskCancelled(db, taskId)) {
      console.log(`[${consumerName}] Task ${taskId} was cancelled — result discarded`);
      cancels.release(taskId);
      m.ack();
      continue;
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

    progress.stop();
    const installedSkillNames = skillsOpened.size ? new Set((await listInstalledSkills().catch(() => [])).map((k) => k.name)) : new Set<string>();
    const skillsUsed = [...skillsOpened].filter((n) => installedSkillNames.has(n));
    const plan = planMode ? (proposedPlan ? planFromProposal(proposedPlan, { version: planVersion, request: planSeed?.request ?? userPrompt, parentTaskId: planSeed?.parentTaskId }) : planFromText(text ?? "", { version: planVersion, request: planSeed?.request ?? userPrompt, parentTaskId: planSeed?.parentTaskId })) : null;
    await (db as any).update(tasks)
      .set({
        status: "completed",
        ...(plan ? { plan } : {}),
        resultMeta: { text, usage, success, error, errorCode, modelUsed: llmConfig.model, completedAt: new Date().toISOString(), ...(plan ? { plan } : {}), ...(sourceCollector.list().length ? { sources: sourceCollector.list() } : {}), seenUrls: sourceCollector.seen(), ...(skillsUsed.length ? { skillsUsed } : {}), ...(taskSecurity.summary() ? { security: taskSecurity.summary() } : {}) },
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), ne(tasks.status, "cancelled")));

    console.log(`[${consumerName}] Task ${taskId} completed.`);
    cancels.release(taskId);
    m.ack();
  } catch (err: any) {
    console.error(`[${consumerName}] Error processing task ${taskId ?? "(unknown)"}:`, err);
    const wasCancelled = taskId ? await isTaskCancelled(db, taskId).catch(() => false) : false;
    cancels.release(taskId);
    if (wasCancelled) console.log(`[${consumerName}] Task ${taskId} was cancelled — not reported as failed`);
    if (taskId && !wasCancelled) {
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
        await (db as any).update(tasks).set({ status: "failed", resultMeta: {
            success: false,
            // A model call that ran out of time is the common case; the chat explains it.
            errorCode: /Timeout of \d+ms: LLM call/.test(String(err?.message ?? "")) ? "llm_timeout" : undefined,
            error: String(err?.message ?? err ?? "unknown error").replace(/^\[[\w-]+\] /, "").slice(0, 500),
            completedAt: new Date().toISOString(),
          }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      } catch { /* ignore */ }
    }
    m.ack();
  }
}

process.on("SIGINT", () => {
  console.log(`[${consumerName}] Shutting down...`);
  process.exit(0);
});

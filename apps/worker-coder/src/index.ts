// Local LLM model routing fix applied - 2026-05-04
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createWriteStream, mkdirSync } from "node:fs";

import { loadEnv, envFile, dataRoot, storageDir, agentsDir, logsDir, usersDir, resultsDir, craftDir, readLocalLlmEnv } from "@hydraops/config";

loadDotenv({ path: envFile });

import { cronUnreadSources, cronReadSourcesPrompt, addUsage, CRON_SOURCES_UNREAD, CRON_SOURCES_UNREAD_TEXT, createDb, events, outbox, processedEvents, tasks, agentConfigs, systemConfigs, workerStatus, recordToolUsage, recordSecurityEvents, createPendingAction, loadPendingAction, finishPendingAction, loadTaskActions, createContinuationTask, buildCronDedupContext, filterCronAnswer, cronNothingNewPrompt, CRON_NOTHING_NEW, loadRecentChannelHistory, historyBudgetChars, searchAgentTasks, isTaskCancelled, lastTaskToolNames, taskChainAutoApproved } from "@hydraops/db";
import { parseEnvelope, buildEnvelope } from "@hydraops/events";
import { connectNats, ensureEventsStream, getJs, publishJson, subjectForType, createCancelRegistry } from "@hydraops/nats";
import { eq, and, desc, ne } from "drizzle-orm";
import { generateText as llmGenerateText, resolveLLMConfig, resolveMaxSteps, buildUserMessage } from "@hydraops/llm";
import { createResultFiles, mcpServerEnv, createRegistry, createSourceCollector, historyAssistantText, createTaskSecurity, resolveSecurityMode, executeApprovedCall, continuationPrompt, filterMcpConfigForTools, EXTERNAL_CONTENT_RULE, skillsPromptSection, isValidSkillName, listInstalledSkills, createProgressTracker, createTaskVault, vaultBudgetChars, stepToolImages, planModePrompt, planFromProposal, planFromText, createPlanTools, type Plan, setupToolsOnDemand, harvestMediaFiles } from "@hydraops/addons";

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

const { db, pool, client: sqliteClient } = createDb(env.DATABASE_URL);
const nc = await connectNats(env.NATS_URL);
await ensureEventsStream(nc);
const js = await getJs(nc);
// Stop button / /cancel: aborts the task this worker is running (see createCancelRegistry).
const cancels = createCancelRegistry(nc, consumerName);

console.log(`[worker-coder] listening for agent.task_assigned on ${env.NATS_URL}`);

// --- TOOL REGISTRY & MCP SETUP ---
const globalRegistry = await createRegistry();
// The MCP servers this worker connects: the ones the agents of its kind were given in
// their tools.md. A server no such agent uses is not started here (every worker used to
// start every server). An agent whose task arrives here counts as this worker's from
// then on, whatever its configured type. On any trouble the whole config is used, as before.
const servedAgents = new Set<string>();
async function mcpConfigForMyAgents(configStr: string, servingAgent?: string): Promise<string> {
  try {
    if (servingAgent) servedAgents.add(servingAgent);
    const cfgs = await (db as any).select().from(agentConfigs);
    const typeOf = new Map<string, string>(cfgs.map((c: any) => [String(c.agentId), String(c.workerType || "coder")]));
    const dirs: string[] = await (await import("node:fs/promises")).readdir(agentsDir).catch(() => []);
    const lines: string[] = [];
    for (const id of dirs) {
      if (id.startsWith(".") || ((typeOf.get(id) ?? "coder") !== 'coder' && !servedAgents.has(id))) continue;
      lines.push(...(await readAgentToolLines(id)));
    }
    return filterMcpConfigForTools(configStr, lines);
  } catch { return configStr; }
}
async function storedMcpConfig(): Promise<string> {
  const rows = await (db as any).select().from(systemConfigs).where(eq(systemConfigs.key, "mcp_servers_config")).limit(1);
  return rows[0]?.value || process.env.mcp_servers_config || '{"mcpServers":{}}';
}
// They start connecting now, in the background: a server can take longer than a task is
// willing to wait, and the first task should find them ready.
(async () => {
  try {
    await globalRegistry.mcpManager.ensure(await mcpConfigForMyAgents(await storedMcpConfig()), 0);
  } catch (e: any) { console.warn(`[worker-coder]`, `MCP warm-up failed: ${e?.message ?? e}`); }
})();

// --- HEARTBEAT ---
async function sendHeartbeat() {
  try {
    // A connection installed from Herramientas, or a change in an agent's tools, takes effect here.
    storedMcpConfig().then(mcpConfigForMyAgents).then((c) => globalRegistry.mcpManager.ensure(c, 0)).catch(() => {});
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

function withWorkerTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(new Error(`[worker-coder] Timeout of ${ms}ms reached: ${label}`)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

import { AckPolicy } from "nats";


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
  // Connect or reconnect what changed; a server that failed earlier is retried here.
  const agentId = String(action.agentId);
  await globalRegistry.mcpManager.ensure(await mcpConfigForMyAgents(mcpServersConfigStr, agentId), 15_000);
  console.log(`[worker-coder] Running approved ${action.toolName} (${actionId}) for ${agentId}...`);
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
  // Every call of that task decided (and at least one ran) → the agent carries on with the outcomes.
  try {
    const next = await createContinuationTask(db, { taskId: String(action.taskId), producer: consumerName });
    if (next) console.log(`[${consumerName}] Continuation task ${next} created for ${action.taskId}.`);
  } catch (e: any) { console.warn(`[${consumerName}] could not create the continuation task: ${e?.message ?? e}`); }
  console.log(`[worker-coder] Approved ${action.toolName} (${actionId}): ${outcome.ok ? "executed" : "failed"}.`);
}
const approvalsSub = await js.pullSubscribe(subjectForType("action.approved"), {
  stream: "EVENTS",
  config: {
    durable_name: "worker_coder_action_approved",
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
      if (data.workerType === "coder") {
        approvedId = String(data?.actionId ?? "");
        const inserted = await (db as any).insert(processedEvents).values({ consumerName, eventId: envlp.id })
          .onConflictDoNothing().returning({ eventId: processedEvents.eventId });
        if (inserted.length > 0) await runApprovedAction(String(data.actionId));
      }
    } catch (e: any) {
      console.error(`[worker-coder] approved action failed: ${e?.message ?? e}`);
      if (approvedId) await finishPendingAction(db, approvedId, "failed", String(e?.message ?? e)).catch(() => {});
    }
    m.ack();
  }
})();

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
    if (taskRows[0]?.status === "cancelled") {
      console.log(`[${consumerName}] Task ${taskId} was cancelled before it started — skipped`);
      m.ack();
      continue;
    }
    const task = taskRows[0];
    
    // Priority: 1. Prompt from event, 2. Prompt from DB
    let userPrompt = (envlp.data as any).prompt as string || task?.prompt || '';
    // A continuation: the user decided on the calls held in the original task; the message
    // carries the outcomes so the agent picks up where it stopped (see approvals.ts).
    const continuationOf = taskRows[0]?.continuationOf ? String(taskRows[0].continuationOf) : null;
    if (continuationOf) {
      const decided = await loadTaskActions(db, continuationOf);
      const originalRows = await (db as any).select({ prompt: tasks.prompt }).from(tasks).where(eq(tasks.id, continuationOf)).limit(1);
      if (decided.length) userPrompt = continuationPrompt(String(originalRows[0]?.prompt ?? ""), decided);
    }
    
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
- The chat renders Markdown. For diagrams or simple charts, answer with a \`\`\`mermaid fenced code block (flowchart, sequence, pie, timeline…) — it renders as a real diagram. Use Markdown tables for tabular data; avoid ASCII-art boxes.
- Text the user will copy and paste somewhere else (a prompt, a command, a message to send, a snippet) goes whole inside a fenced code block of its own (three backticks; a quote or bold text is not a frame): the chat shows it there with a copy button. Your own comments stay outside the block. If that text has a fenced block inside, open and close the outer one with four backticks.
- If the user only greets, introduce yourself briefly according to your soul.
- You can only act through the tools listed for you. If a request needs something you have no tool for (asking another agent, sending a message, running code…), say so plainly and suggest what the user can do — never claim to have done it.
- Links: only give a URL you actually opened or saw in a tool result or in this conversation (earlier answers list their sources). Never reconstruct an address from memory, and never call one "verified" or "confirmed" unless you opened it in this turn. If you do not have the link, say so and offer to look it up.
${EXTERNAL_CONTENT_RULE}
- If there is a direct question or task, answer without greeting first.${userProfile}`;

    console.log(`[worker-coder] Processing task ${taskId} for agent ${agentId}...`);
    
    // --- MCP & SYSTEM TOOLS ---
    const nativeAddonsStateStr = getGlobalConfig('native_addons_state', '{}');
    const mcpServersConfigStr = getGlobalConfig('mcp_servers_config', '{"mcpServers":{}}');
    
    // Connect or reconnect what changed; a server that failed earlier is retried here.
    await globalRegistry.mcpManager.ensure(await mcpConfigForMyAgents(mcpServersConfigStr, agentId), 15_000);
    
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
    // /plan: this task only reads and proposes (see @hydraops/addons plan.ts). The
    // read-only cut of the agent's tools, plus propose_plan; the plan lands on the task.
    const planMode = taskRows[0]?.mode === "plan";
    const planSeed: Plan | null = planMode && taskRows[0]?.plan && typeof taskRows[0].plan === "object" ? (taskRows[0].plan as Plan) : null;
    const planParentRows = planSeed?.parentTaskId ? await (db as any).select({ plan: tasks.plan }).from(tasks).where(eq(tasks.id, planSeed.parentTaskId)).limit(1) : [];
    const planPrevious: Plan | null = planParentRows[0]?.plan && typeof planParentRows[0].plan === "object" ? (planParentRows[0].plan as Plan) : null;
    const planVersion = planSeed?.version ?? 1;
    const allowedToolsAll = globalRegistry.resolveAllowedToolNames(agentRequestedTools, enabledMcpServers);
    const allowedTools = planMode ? globalRegistry.readOnlyToolNames(allowedToolsAll) : allowedToolsAll;

    console.log(`[worker-coder] Enabled MCP servers from chat: [${enabledMcpServers.join(', ')}] → ${allowedTools.length} tools total`);

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
    // Long tool results are kept whole here and digested for the model (see @hydraops/addons vault.ts).
    const vault = createTaskVault({ dir: path.join(resultsDir, taskId!, "vault"), onChange: (s) => progress.vault(s), budgetChars: vaultBudgetChars(llmConfig.provider) });
    // A task carrying out a plan starts with what the planning task already read.
    if (taskRows[0]?.planOf) await vault.importFrom(path.join(resultsDir, String(taskRows[0].planOf), "vault")).catch(() => 0);
    if (continuationOf) await vault.importFrom(path.join(resultsDir, continuationOf, "vault")).catch(() => 0);
    // Tools the user approved "for the rest of the task" on this chain: they no longer ask.
    const autoApproved = await taskChainAutoApproved(db, taskId!).catch(() => [] as string[]);
    const taskSecurity = createTaskSecurity({
      mode: resolveSecurityMode(getGlobalConfig("security_mode", "ask"), cfgRows[0]?.securityMode),
      // One image per task is bound elsewhere; a video is held (it is the costly one).
      neverHold: ["generate_image", ...autoApproved],
      // The agent's permanent memory: an injected rule saved there would outlive the task.
      alwaysHold: ["remember"],
      // Delegated by a task that had read outside content (delegate_task passes it on).
      inherited: Array.isArray(taskRows[0]?.inheritedTaint) ? taskRows[0].inheritedTaint : undefined,
      onHold: ({ toolName, args, origins }) => createPendingAction(db, { taskId: taskId!, agentId, channel, toolName, args, origins }),
    });
    // Bind the calling agent's identity so identity-aware tools (`remember`,
    // `recall`) act on the right agent without trusting model input.
    const resultFiles = createResultFiles(storageDir);
    const toolContext = {
      agentId,
      searchPastTasks: (query: string, limit?: number) => searchAgentTasks(sqliteClient, agentId, query, limit),
      // recall: a past answer written after reading outside content taints this task too.
      external: (tool: string, ref: string | undefined, content: string) => taskSecurity.external(tool, ref, content),
      // delegate_task: hand this task's taint on to the agent it delegates to.
      taintOrigins: () => taskSecurity.origins(),
      // comfy_workflows: where a prepared workflow and a collected result are written, where
      // the user's attachments are, and the address its connection is configured with.
      filesDir: path.join(storageDir, "results", String(taskId)),
      uploadsDir: path.join(storageDir, "uploads"),
      connectionEnv: (server: string) => mcpServerEnv(mcpServersConfigStr, server),
      // Files a tool leaves for the user: stored with the result, shown in the chat.
      addResultFile: resultFiles.add,
    };
    // A continuation after approvals: the media those calls named (they ran without a task)
    // is brought into this one, so it gets its card under the reply.
    if (continuationOf) {
      for (const a of await loadTaskActions(db, continuationOf).catch(() => [] as any[])) {
        if (a.status === "executed" && a.result) await harvestMediaFiles(a.result, toolContext);
      }
    }
    // Installed skills, by name and description, for an agent that may use them (the
    // full text is opened on demand with skills_view; see @hydraops/addons skills.ts).
    const skillsSection = await skillsPromptSection(allowedTools.filter((n: string) => globalNativeState[n] !== false)).catch(() => "");
    const aiTools = globalRegistry.getAiSdkTools(allowedTools, globalNativeState, usageSink, toolContext, sourceCollector.sink, taskSecurity, progress.sink, vault);

    // Tools on demand (see @hydraops/addons tools-on-demand.ts): above the threshold the model
    // gets an index and loads full definitions as it needs them. What the same chat used in
    // its previous task, the calls a continuation carries and whatever the message names
    // start loaded. Off with TOOLS_ON_DEMAND=off (Config).
    const onDemand = setupToolsOnDemand({
      sources: globalRegistry.indexSources(),
      allowedNames: allowedTools,
      enabled: getGlobalConfig("TOOLS_ON_DEMAND", "on").trim().toLowerCase() !== "off",
      text: userPrompt,
      preload: continuationOf ? (await loadTaskActions(db, continuationOf).catch(() => [] as any[])).map((a: any) => String(a.toolName)) : [],
      previousTask: await lastTaskToolNames(db, channel).catch(() => [] as string[]),
    });
    if (onDemand) console.log(`[worker-coder] tools on demand: ${onDemand.loader.summary().total} in the index, ${onDemand.loader.active().length - 1} preloaded`);
    const rawTools = globalRegistry.getRawTools(allowedTools, globalNativeState, usageSink, toolContext, sourceCollector.sink, taskSecurity, progress.sink, vault);
    let proposedPlan: unknown = null;
    const planTools = planMode ? createPlanTools((proposal) => { proposedPlan = proposal; }) : null;
    const planSection = planMode ? planModePrompt({ toolNames: allowedTools, previous: planPrevious ?? undefined, userNotes: planPrevious ? userPrompt : undefined, version: planVersion }) : "";

    // Fetch conversation history (last 10 completed tasks in this channel)
    // The channel's last exchanges (30 days, 20 at most, within a size budget); empty for
    // cron-fired tasks (see loadRecentChannelHistory).
    const historyRows = await loadRecentChannelHistory(db, channel, taskId, { maxChars: historyBudgetChars(llmConfig.provider) });

    const history = historyRows.reverse().map((t: any) => {
      const assistantText = historyAssistantText(t.resultMeta);
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
    const controller = cancels.track(taskId);
    // What each model step carried (see @hydraops/llm StepBreakdown), kept with the result.
    let stepBreakdown: any[] = [];
    const modelTools = { ...(planTools ? { ...aiTools, ...planTools.ai } : aiTools), ...(onDemand?.tools ?? {}) };
    const runModel = (extra: any[] = []) => withWorkerTimeout(
      llmGenerateText(
        llmConfig,
        [...finalMessages, ...extra],
        systemPrompt + skillsSection + planSection + cronDedup + vault.promptSection() + (onDemand?.promptSection ?? ""),
        modelTools,
        planTools ? [...rawTools, ...planTools.raw] : rawTools,
        { abortSignal: controller.signal, prepareStep: (step: any) => vault.prepareStep(step), stepImages: stepToolImages, maxSteps: resolveMaxSteps(cfgRows[0]?.maxSteps), ...(onDemand ? onDemand.llmOptionsFor(modelTools) : {}), onBreakdown: (b: any[]) => { stepBreakdown = b; } }
      ),
      LLM_TIMEOUT_MS(llmConfig.provider),
      `LLM call (${llmConfig.provider}:${llmConfig.model})`,
      () => controller.abort(new Error("LLM call timed out")),
    );
    let run: any = await runModel();

    // A scheduled task that names its sources must have opened at least one of them
    // (@hydraops/db cron-sources.ts): ask once more, then deliver a failure, not news.
    if (run.success) {
      const unread = await cronUnreadSources(db, taskId, sourceCollector.list()).catch(() => null);
      if (unread) {
        console.log(`[worker-coder] Scheduled task ${taskId} answered without opening its sources; asking again.`);
        const retry = await runModel([{ role: "assistant", content: String(run.text ?? "") }, { role: "user", content: cronReadSourcesPrompt(unread) }]);
        const still = retry.success ? await cronUnreadSources(db, taskId, sourceCollector.list()).catch(() => null) : unread;
        const both = addUsage(run.usage, retry.usage);
        if (still) console.warn(`[worker-coder] Scheduled task ${taskId} did not open its sources twice; delivered as a failure.`);
        run = still
          ? { ...retry, usage: both, success: false, text: CRON_SOURCES_UNREAD_TEXT, error: CRON_SOURCES_UNREAD_TEXT, errorCode: CRON_SOURCES_UNREAD }
          : { ...retry, usage: both };
      }
    }
    const { text: draftText, usage, success, error, errorCode } = run;

    // A scheduled task's answer loses the items its earlier runs already delivered; when
    // nothing is left, it becomes one line (the record and the filter: @hydraops/db cron-dedup.ts).
    let text = draftText;
    if (success && text) {
      try {
        const filtered = await filterCronAnswer(db, taskId, text, sourceCollector.list());
        if (filtered) {
          console.log(`[worker-coder] Scheduled task ${taskId}: ${filtered.reason}`);
          if (filtered.text !== null) text = filtered.text;
          else {
            const line = await llmGenerateText(llmConfig, [{ role: "user", content: cronNothingNewPrompt(userPrompt) }] as any, undefined, undefined, undefined, { abortSignal: controller.signal });
            const said = (line.success ? String(line.text ?? "") : "").trim();
            text = said && said.length <= 200 && !said.includes("\n") ? said : CRON_NOTHING_NEW;
          }
        }
      } catch (e: any) {
        console.warn(`[worker-coder] repeat check failed: ${e?.message ?? e}`);
      }
    }
    console.log(`[worker-coder] [LLM] Call finished. Success: ${success}`);

    // Persist tool usage for this task (best-effort; never break processing).
    if (toolUsageLog.length) {
      try { await recordToolUsage(db, agentId, taskId, toolUsageLog); }
      catch (e: any) { console.warn(`[worker-coder] tool usage tracking failed: ${e?.message ?? e}`); }
    }
    if (taskSecurity.events().length) {
      try { await recordSecurityEvents(db, agentId, taskId, taskSecurity.events()); }
      catch (e: any) { console.warn(`[worker-coder] security log failed: ${e?.message ?? e}`); }
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

    // Cancelled while it ran: the row already says so — write nothing, publish nothing, overwrite nothing.
    if (await isTaskCancelled(db, taskId)) {
      console.log(`[${consumerName}] Task ${taskId} was cancelled — result discarded`);
      cancels.release(taskId);
      m.ack();
      continue;
    }
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

    progress.stop();
    const installedSkillNames = skillsOpened.size ? new Set((await listInstalledSkills().catch(() => [])).map((k) => k.name)) : new Set<string>();
    const skillsUsed = [...skillsOpened].filter((n) => installedSkillNames.has(n));
    const plan = planMode ? (proposedPlan ? planFromProposal(proposedPlan, { version: planVersion, request: planSeed?.request ?? userPrompt, parentTaskId: planSeed?.parentTaskId }) : planFromText(text ?? "", { version: planVersion, request: planSeed?.request ?? userPrompt, parentTaskId: planSeed?.parentTaskId })) : null;
    await (db as any).update(tasks)
      .set({ 
        status: "completed",
        ...(plan ? { plan } : {}),
        resultMeta: { text, usage, success, error, errorCode, modelUsed: llmConfig.model, completedAt: new Date().toISOString(), ...(onDemand ? { toolsOnDemand: onDemand.loader.summary() } : {}), ...(stepBreakdown.length ? { steps: stepBreakdown } : {}), ...(resultFiles.list().length ? { files: resultFiles.list() } : {}), ...(plan ? { plan } : {}), ...(sourceCollector.list().length ? { sources: sourceCollector.list() } : {}), seenUrls: sourceCollector.seen(), ...(skillsUsed.length ? { skillsUsed } : {}), ...(vault.summary().docs ? { vault: vault.summary() } : {}), ...(taskSecurity.summary() ? { security: taskSecurity.summary() } : {}) },
        updatedAt: new Date()
      })
      .where(and(eq(tasks.id, taskId), ne(tasks.status, "cancelled")));

    console.log(`[worker-coder] Task ${taskId} marked as completed.`);
    cancels.release(taskId);
    m.ack();
  } catch (err: any) {
    console.error(`[worker-coder] Unhandled error processing task ${taskId ?? "(unknown)"}:`, err);
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
      } catch (e) { console.error(`[worker-coder] failed to publish task.failed`, e); }
      try {
        await (db as any).update(tasks)
          .set({ status: "failed", resultMeta: {
            success: false,
            // A model call that ran out of time is the common case; the chat explains it.
            errorCode: /Timeout of \d+ms: LLM call/.test(String(err?.message ?? "")) ? "llm_timeout" : undefined,
            error: String(err?.message ?? err ?? "unknown error").replace(/^\[[\w-]+\] /, "").slice(0, 500),
            completedAt: new Date().toISOString(),
          }, updatedAt: new Date() })
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

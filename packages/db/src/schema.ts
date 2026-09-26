import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey
} from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  channel: text("channel").notNull().default("main"),
  status: text("status").notNull(),
  assignedAgent: text("assigned_agent"),
  // Set when this task was fired by a cron job; lets a run dedup against the
  // previous runs of the SAME cron regardless of channel (see buildCronDedupContext).
  cronId: text("cron_id"),
  resultRef: text("result_ref"),
  resultMeta: text("result_meta", { mode: "json" }),
  workflowChain: text("workflow_chain", { mode: "json" }),
  workflowStep: integer("workflow_step").default(0),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  // Prompt-injection defense: where the outside content came from when this task was
  // delegated by one that had read some. The worker starts it tainted (provenance.ts).
  inheritedTaint: text("inherited_taint", { mode: "json" }),
  // What the agent is doing while the task runs (steps: thinking, a tool with what it is
  // working on, a held action), written by the worker and shown under the typing dots.
  progress: text("progress", { mode: "json" }),
  // /plan: "plan" = the agent only reads and proposes a plan (see @hydraops/addons plan.ts);
  // null = a normal task. `plan` holds the proposal and its state; `planOf` links an
  // execution task to the plan it carries out.
  mode: text("mode"),
  plan: text("plan", { mode: "json" }),
  planOf: text("plan_of"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    producer: text("producer").notNull(),
    subjectEntity: text("subject_entity").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (t) => ({
    typeIdx: index("events_type_idx").on(t.type),
    subjectIdx: index("events_subject_idx").on(t.subjectEntity, t.subjectId),
  })
);

export const outbox = sqliteTable(
  "outbox",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    lastError: text("last_error"),
  },
  (t) => ({
    pendingIdx: index("outbox_pending_idx").on(t.status, t.nextAttemptAt),
  })
);

export const processedEvents = sqliteTable(
  "processed_events",
  {
    consumerName: text("consumer_name").notNull(),
    eventId: text("event_id").notNull(),
    processedAt: integer("processed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.consumerName, t.eventId] }),
  })
);

export const agentConfigs = sqliteTable("agent_configs", {
  agentId: text("agent_id").primaryKey(),
  model: text("model").notNull(),
  workerType: text("worker_type").default("coder"),
  graphicEngine: text("graphic_engine").default("auto"),
  graphicFormat: text("graphic_format").default("png"),
  // Aspect ratio for image/video generation: auto | 1:1 | 16:9 | 9:16 | 4:3 | 3:4
  resolution: text("resolution").default("auto"),
  // Prompt-injection defense: ask (hold sensitive calls on a task that read outside
  // content until the user approves) | trusted (run them, just record). See
  // @hydraops/addons provenance.ts. The global switch lives in system_configs.
  securityMode: text("security_mode").default("ask"),
  lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const systemConfigs = sqliteTable("system_configs", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  cronExpression: text("cron_expression").notNull(),
  assignedAgent: text("assigned_agent"),
  status: text("status").notNull().default("active"), // 'active' | 'paused'
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const workerStatus = sqliteTable("worker_status", {
  workerId: text("worker_id").primaryKey(),
  status: text("status").notNull().default("online"),
  lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// One row per tool invocation, written by the worker after the LLM turn. Powers
// the per-agent tool tracking: which tools/add-ons/MCP an agent actually uses,
// how often, when last, and how many were blocked by the security guard. This is
// usage history — distinct from what a tools.md merely grants an agent.
export const toolUsage = sqliteTable(
  "tool_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id"),
    toolName: text("tool_name").notNull(),
    source: text("source").notNull().default("native"), // native | my_addons | mcp
    status: text("status").notNull().default("ok"),      // ok | blocked | error
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    agentIdx: index("tool_usage_agent_idx").on(t.agentId),
    toolIdx: index("tool_usage_tool_idx").on(t.toolName),
    createdIdx: index("tool_usage_created_idx").on(t.createdAt),
  })
);

// A sensitive tool call an agent wanted to make on a task that had read outside
// content. It was NOT run; the user approves or rejects it from the chat, and on
// approval the agent's worker runs the stored call as-is, without the model.
export const pendingActions = sqliteTable(
  "pending_actions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    channel: text("channel").notNull(),
    toolName: text("tool_name").notNull(),
    args: text("args", { mode: "json" }).notNull(),
    // Where the outside content came from (tool + url/query), for the card.
    origins: text("origins", { mode: "json" }).notNull(),
    // pending | approved | executed | failed | rejected | expired
    status: text("status").notNull().default("pending"),
    result: text("result"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    // When the Telegram bot sent this call with its Approve / Reject buttons.
    notifiedAt: integer("notified_at", { mode: "timestamp" }),
  },
  (t) => ({
    channelIdx: index("pending_actions_channel_idx").on(t.channel),
    taskIdx: index("pending_actions_task_idx").on(t.taskId),
    statusIdx: index("pending_actions_status_idx").on(t.status),
  })
);

// Prompt-injection defense log (see @hydraops/addons provenance.ts): when a task
// first took in third-party content, and every sensitive tool call made after that.
export const securityEvents = sqliteTable(
  "security_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id"),
    type: text("type").notNull(), // tainted | sensitive_after_taint
    toolName: text("tool_name").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    taskIdx: index("security_events_task_idx").on(t.taskId),
    createdIdx: index("security_events_created_idx").on(t.createdAt),
  })
);


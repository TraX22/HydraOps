import { z } from "zod";

// -----------------------------
// Envelope
// -----------------------------

export const EnvelopeBaseSchema = z.object({
  specVersion: z.literal("1.0"),
  id: z.string().uuid(),
  type: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  producer: z.string().min(1),
  subject: z.object({
    entity: z.string().min(1),
    id: z.string(),
  }),
  data: z.unknown(),
  meta: z.record(z.unknown()).optional(),
  trace: z
    .object({
      traceId: z.string().min(1),
      correlationId: z.string().min(1).optional(),
      causationId: z.string().uuid().optional(),
    })
    .optional(),
});

export type Envelope<TType extends string, TData> = {
  specVersion: "1.0";
  id: string;
  type: TType;
  version: number;
  occurredAt: string;
  producer: string;
  subject: { entity: string; id: string };
  data: TData;
  meta?: Record<string, unknown>;
  trace?: {
    traceId: string;
    correlationId?: string;
    causationId?: string;
  };
};

// -----------------------------
// Event payload schemas (v1)
// -----------------------------

// -----------------------------
// Event payload schemas (v1)
// -----------------------------

export const TaskCreatedV1 = z.object({
  taskId: z.string().uuid(),
  prompt: z.string().min(1),
  userId: z.string().min(1),
  channel: z.string().min(1),
  priority: z.enum(["low", "normal", "high"]),
  date: z.string().datetime(),
});

export const AgentTaskAssignedV1 = z.object({
  taskId: z.string().uuid(),
  agentId: z.string().min(1),
  agentType: z.string().optional(),    // legacy field, use workerType
  workerType: z.string().optional(),    // coder | graphic | general
  channel: z.string().min(1),
  prompt: z.string().optional(),
  assignedAt: z.string().datetime().optional(),
});

export const AgentResultGeneratedV1 = z.object({
  taskId: z.string().uuid(),
  agentId: z.string().min(1),
  resultRef: z.string().min(1), // "results/<taskId>/result.json"
  tokensUsed: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  preview: z.string().max(2000).optional(),
});

export const SystemCronUpdatedV1 = z.object({});

// -----------------------------
// Registry
// -----------------------------

export const registry = {
  "task.created": { 1: TaskCreatedV1 },
  "agent.task_assigned": { 1: AgentTaskAssignedV1 },
  "agent.result_generated": { 1: AgentResultGeneratedV1 },
  "system.cron_updated": { 1: SystemCronUpdatedV1 },
} as const;

export type EventType = keyof typeof registry;

export function parseEnvelope(input: unknown) {
  const base = EnvelopeBaseSchema.parse(input);
  const byVersion = (registry as any)[base.type];
  if (!byVersion) throw new Error(`Unknown event type: ${base.type}`);
  const schema = byVersion[base.version];
  if (!schema)
    throw new Error(`Unsupported version ${base.version} for event type ${base.type}`);

  return {
    ...base,
    data: schema.parse(base.data),
  };
}

export function buildEnvelope<TType extends EventType, TVersion extends number>(args: {
  id: string;
  type: TType;
  version: TVersion;
  occurredAt: string;
  producer: string;
  subject: { entity: string; id: string };
  data: unknown;
  meta?: Record<string, unknown>;
  trace?: { traceId: string; correlationId?: string; causationId?: string };
}) {
  // runtime validate base + payload
  return parseEnvelope({ specVersion: "1.0", ...args });
}

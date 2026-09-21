import { connect, type JetStreamClient, type NatsConnection, StringCodec, RetentionPolicy, StorageType } from "nats";

const sc = StringCodec();

export async function connectNats(natsUrl: string): Promise<NatsConnection> {
  return connect({ servers: natsUrl });
}

export async function getJs(nc: NatsConnection): Promise<JetStreamClient> {
  return nc.jetstream();
}

export async function ensureEventsStream(nc: NatsConnection) {
  const jsm = await nc.jetstreamManager();
  const name = "EVENTS";

  try {
    await jsm.streams.info(name);
  } catch {
    await jsm.streams.add({
      name,
      subjects: ["claw.>"],
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7d in ns
      storage: StorageType.File,
      num_replicas: 1,
    });
  }
}

export async function publishJson(js: JetStreamClient, subject: string, payload: unknown) {
  const data = sc.encode(JSON.stringify(payload));
  return js.publish(subject, data, {
    headers: undefined,
  });
}

export function subjectForType(type: string) {
  return `claw.${type}`;
}

/**
 * Task cancellation on the worker side. A worker tracks the task it is running;
 * when a `task.cancel_requested` event names it, its AbortController fires and the
 * model call (and anything else holding the signal) stops.
 *
 * A plain core subscription on purpose: only live messages matter. A cancel for a
 * task that is not running here needs no action (the API already marked the row
 * `cancelled`, and workers skip cancelled rows when they pick them up).
 */
export function createCancelRegistry(nc: NatsConnection, label = "worker") {
  const running = new Map<string, AbortController>();
  const sub = nc.subscribe(subjectForType("task.cancel_requested"));
  (async () => {
    for await (const m of sub) {
      try {
        const taskId = JSON.parse(sc.decode(m.data))?.data?.taskId;
        const controller = typeof taskId === "string" ? running.get(taskId) : undefined;
        if (controller && !controller.signal.aborted) {
          console.log(`[${label}] cancel requested for task ${taskId} — aborting`);
          controller.abort(new Error("Task cancelled by the user"));
        }
      } catch { /* malformed message: ignore */ }
    }
  })().catch(() => { /* connection closed */ });

  return {
    /** Start tracking a task; returns the controller whose signal goes to the model call. */
    track(taskId: string): AbortController {
      const controller = new AbortController();
      running.set(taskId, controller);
      return controller;
    },
    release(taskId: string | undefined): void {
      if (taskId) running.delete(taskId);
    },
  };
}

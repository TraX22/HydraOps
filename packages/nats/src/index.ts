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

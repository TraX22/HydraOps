import { eq } from "drizzle-orm";
import * as schema from "./schema.js";

// Projects: a folder of the user's with code in it, one agent that works on it, and a chat
// of its own. They are few and only the API writes them, so they live as one list in
// system_configs; the orchestrator and the workers read it.
//
// A project's chat is the channel `project:<id>`: its tasks, its history and the calls it
// holds for approval hang from that channel like those of any other chat.

export interface ProjectRecord {
  id: string;
  name: string;
  /** The name as a branch can carry it: the agents' branch is `hydraops/<slug>`. */
  slug: string;
  /** The user's folder, as the real absolute path it names. */
  folder: string;
  agentId: string;
  /** Also load the agent's own memory file in this project's chat (off: only the project's). */
  agentMemory: boolean;
  /** sha256 of the HydraOps.md the user accepted; another content is not in force. */
  instructionsHash: string | null;
  /** Secrets files of the user's folder (.env, .dev.vars) copied into the agents' copy while a server of the project runs. */
  serverSecrets: string[];
  createdAt: string;
}

export const PROJECTS_KEY = "projects";
export const PROJECT_CHANNEL_PREFIX = "project:";
export const MAX_PROJECTS = 40;

export const projectChannel = (id: string) => `${PROJECT_CHANNEL_PREFIX}${id}`;
/** The project a chat channel belongs to, or null for any other channel. */
export function projectIdOfChannel(channel: unknown): string | null {
  const c = typeof channel === "string" ? channel : "";
  if (!c.startsWith(PROJECT_CHANNEL_PREFIX)) return null;
  const id = c.slice(PROJECT_CHANNEL_PREFIX.length);
  return /^[a-z0-9-]{6,64}$/i.test(id) ? id : null;
}

const isRecord = (p: any): p is ProjectRecord =>
  p && typeof p.id === "string" && typeof p.name === "string" && typeof p.slug === "string"
  && typeof p.folder === "string" && typeof p.agentId === "string";

export async function loadProjects(db: any): Promise<ProjectRecord[]> {
  const rows = await db.select().from(schema.systemConfigs).where(eq(schema.systemConfigs.key, PROJECTS_KEY)).limit(1);
  try {
    const v = JSON.parse(rows[0]?.value ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(isRecord).map((p) => ({
      id: p.id, name: p.name, slug: p.slug, folder: p.folder, agentId: p.agentId,
      agentMemory: p.agentMemory === true,
      instructionsHash: typeof p.instructionsHash === "string" ? p.instructionsHash : null,
      serverSecrets: Array.isArray((p as any).serverSecrets) ? (p as any).serverSecrets.filter((x: unknown) => typeof x === "string").slice(0, 20) : [],
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(0).toISOString(),
    }));
  } catch { return []; }
}

export async function saveProjects(db: any, list: ProjectRecord[]): Promise<void> {
  const value = JSON.stringify(list);
  await db.insert(schema.systemConfigs)
    .values({ key: PROJECTS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.systemConfigs.key, set: { value, updatedAt: new Date() } })
    .run();
}

export async function findProject(db: any, id: string | null | undefined): Promise<ProjectRecord | null> {
  if (!id) return null;
  return (await loadProjects(db)).find((p) => p.id === id) ?? null;
}

/** The project whose chat `channel` is, or null. */
export const projectOfChannel = (db: any, channel: unknown) => findProject(db, projectIdOfChannel(channel));

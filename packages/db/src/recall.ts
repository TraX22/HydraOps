// Episodic memory search over the tasks table, powered by SQLite FTS5 (bundled
// with better-sqlite3 — no extra infrastructure). An FTS index shadows the tasks
// table via triggers: every completed task's prompt + result text becomes
// searchable, and rows follow task updates/deletes automatically. The triggers
// live in the database file itself, so once any process has ensured them, tasks
// completed by every writer are indexed.
//
// This powers the `recall` native tool: the worker binds a search closure with
// the agent identity already applied (see ToolContext in @hydraops/addons), so
// an agent can only ever search ITS OWN past tasks.

const FTS_RESULT_MAX_CHARS = 4000; // indexed excerpt of the result text
const PROMPT_CLIP_CHARS = 300;     // prompt length returned per hit
const MAX_HITS = 10;

export interface RecallHit {
  taskId: string;
  date: string; // YYYY-MM-DD
  prompt: string;
  excerpt: string;
}

// One-time-per-process guard; the schema statements are all IF NOT EXISTS so a
// race between workers at first use is harmless.
const ensuredClients = new WeakSet<object>();

/**
 * Create the FTS5 index and its sync triggers if missing, and backfill it from
 * existing completed tasks the first time. Idempotent and cheap after the first
 * call. `client` is the raw better-sqlite3 handle returned by createDb.
 */
export function ensureRecallIndex(client: any): void {
  if (ensuredClients.has(client)) return;
  client.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      task_id UNINDEXED,
      agent_id UNINDEXED,
      prompt,
      result,
      created_at UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS tasks_fts_after_insert AFTER INSERT ON tasks
    WHEN NEW.status = 'completed' BEGIN
      INSERT INTO tasks_fts(task_id, agent_id, prompt, result, created_at)
      VALUES (NEW.id, COALESCE(NEW.assigned_agent, NEW.channel), NEW.prompt,
              substr(COALESCE(json_extract(NEW.result_meta, '$.text'), ''), 1, ${FTS_RESULT_MAX_CHARS}),
              NEW.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_fts_after_update AFTER UPDATE ON tasks BEGIN
      DELETE FROM tasks_fts WHERE task_id = OLD.id;
      INSERT INTO tasks_fts(task_id, agent_id, prompt, result, created_at)
      SELECT NEW.id, COALESCE(NEW.assigned_agent, NEW.channel), NEW.prompt,
             substr(COALESCE(json_extract(NEW.result_meta, '$.text'), ''), 1, ${FTS_RESULT_MAX_CHARS}),
             NEW.created_at
      WHERE NEW.status = 'completed';
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_fts_after_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM tasks_fts WHERE task_id = OLD.id;
    END;
  `);
  const { c } = client.prepare("SELECT count(*) AS c FROM tasks_fts").get() as { c: number };
  if (c === 0) {
    client
      .prepare(
        `INSERT INTO tasks_fts(task_id, agent_id, prompt, result, created_at)
         SELECT id, COALESCE(assigned_agent, channel), prompt,
                substr(COALESCE(json_extract(result_meta, '$.text'), ''), 1, ${FTS_RESULT_MAX_CHARS}),
                created_at
         FROM tasks WHERE status = 'completed'`,
      )
      .run();
  }
  ensuredClients.add(client);
}

/**
 * Full-text search over one agent's completed tasks, best matches (BM25) first.
 * The natural-language query is reduced to bare word tokens combined with OR, so
 * partial matches still rank instead of failing an implicit AND.
 */
export function searchAgentTasks(
  client: any,
  agentId: string,
  query: string,
  limit = 5,
): RecallHit[] {
  ensureRecallIndex(client);
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (tokens.length === 0) return [];
  const match = tokens.map((t) => `"${t}"`).join(" OR ");

  const rows = client
    .prepare(
      `SELECT task_id, prompt, created_at,
              snippet(tasks_fts, 3, '', '', ' … ', 48) AS excerpt
       FROM tasks_fts
       WHERE tasks_fts MATCH ? AND agent_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, agentId, Math.max(1, Math.min(Math.floor(limit), MAX_HITS))) as any[];

  return rows.map((r) => {
    // created_at is stored as unix seconds (drizzle timestamp mode); tolerate ms.
    const ts = Number(r.created_at) > 1e12 ? Number(r.created_at) : Number(r.created_at) * 1000;
    const prompt = String(r.prompt ?? "");
    return {
      taskId: String(r.task_id),
      date: new Date(ts).toISOString().slice(0, 10),
      prompt: prompt.length > PROMPT_CLIP_CHARS ? prompt.slice(0, PROMPT_CLIP_CHARS) + "…" : prompt,
      excerpt: String(r.excerpt ?? "").trim(),
    };
  });
}

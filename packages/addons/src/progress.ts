/**
 * What an agent is doing while a task runs, for the chat's "working" row.
 *
 * Every tool call already goes through the registry (see instrumentTool), so the steps
 * come from there: a tool starting (with the query, page, skill or repo it works on),
 * the model thinking between tools, a call held for the user's approval. The worker
 * persists the list on the task (tasks.progress); the chat reads it with the history it
 * already polls. The labels are built by the UI (localized), from the tool name and ref.
 */
import { redactSecrets } from './guard.js';

export interface ProgressStep {
  kind: 'thinking' | 'tool' | 'held';
  /** Tool name for tool / held steps. */
  tool?: string;
  /** What the tool works on: the search query, the page, the skill, the repo… */
  ref?: string;
  at: string;
}

export interface TaskProgress {
  startedAt: string;
  steps: ProgressStep[];
}

/** Called by the registry around each tool call. */
export type ToolProgressSink = (event: 'start' | 'end' | 'held', toolName: string, args?: unknown) => void;

const MAX_STEPS = 40;
const MAX_REF = 120;
const WRITE_EVERY_MS = 700;

const clipRef = (v: string) => {
  const t = redactSecrets(v.replace(/\s+/g, ' ').trim());
  return t.length > MAX_REF ? t.slice(0, MAX_REF - 1) + '…' : t;
};

/** The one argument that says what a call is about, for the step's label. */
export function progressRef(toolName: string, args: unknown): string | undefined {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string) : undefined);
  if (toolName.startsWith('github')) {
    const repo = str('owner') && str('repo') ? `${str('owner')}/${str('repo')}` : str('repo') ?? str('query') ?? str('path');
    return repo ? clipRef(repo) : undefined;
  }
  const url = str('url') ?? str('videoUrl') ?? str('video_url') ?? str('link');
  if (url) {
    try { const u = new URL(url); return clipRef(u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '')); } catch { return clipRef(url); }
  }
  const v = str('query') ?? str('q') ?? str('name') ?? str('agent') ?? str('title') ?? str('prompt') ?? str('text');
  return v ? clipRef(v) : undefined;
}

/**
 * Keeps the step list of one task and persists it (throttled: at most one write every
 * 0.7 s, the last state always written). `persist` failures are ignored: progress is
 * a courtesy, it must never break a task.
 */
export function createProgressTracker(persist: (p: TaskProgress) => unknown) {
  const now = () => new Date().toISOString();
  const state: TaskProgress = { startedAt: now(), steps: [{ kind: 'thinking', at: now() }] };
  let lastWrite = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    timer = null;
    lastWrite = Date.now();
    try { Promise.resolve(persist({ startedAt: state.startedAt, steps: [...state.steps] })).catch(() => {}); } catch { /* ignore */ }
  };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, WRITE_EVERY_MS - (Date.now() - lastWrite));
    timer = setTimeout(write, wait);
  };
  const push = (step: ProgressStep) => {
    state.steps.push(step);
    // Keep the first step (the start) and the latest ones.
    if (state.steps.length > MAX_STEPS) state.steps.splice(1, state.steps.length - MAX_STEPS);
    schedule();
  };

  // Models call tools in parallel: "thinking" only once none is still running.
  let running = 0;
  const sink: ToolProgressSink = (event, toolName, args) => {
    if (event === 'start') { running++; push({ kind: 'tool', tool: toolName, ref: progressRef(toolName, args), at: now() }); }
    else if (event === 'held') push({ kind: 'held', tool: toolName, ref: progressRef(toolName, args), at: now() });
    else {
      running = Math.max(0, running - 1);
      if (running === 0 && state.steps.at(-1)?.kind !== 'thinking') push({ kind: 'thinking', at: now() });
    }
  };

  write();
  return {
    sink,
    snapshot: (): TaskProgress => ({ startedAt: state.startedAt, steps: [...state.steps] }),
    /** Stops pending writes (the task finished; the final result replaces the typing row). */
    stop: () => { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

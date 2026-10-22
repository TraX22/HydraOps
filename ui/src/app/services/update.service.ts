import { Injectable, inject, signal, computed } from '@angular/core';
import { ApiService, SelfUpdateStatus, VersionInfo } from './api.service';

/**
 * One state for the sidebar's update block, whatever the installation:
 *
 * - the installed desktop app (Electron, packaged): electron-updater downloads a new
 *   version on its own and the block goes available → downloading → ready, where the
 *   user presses "Restart and install";
 * - an installation from source (a git clone: the headless server, the desktop shell in
 *   development): the block offers "Update to X", which asks the API to pull, rebuild
 *   and restart the services, and shows the step in progress until the app reloads.
 */
export type UpdateState =
  | { kind: 'idle'; current: string | null; checkedAt?: number }
  | { kind: 'checking'; current: string | null }
  | { kind: 'available'; current: string | null; latest: string }
  | { kind: 'downloading'; current: string | null; latest: string; percent: number; transferred: number; total: number }
  | { kind: 'ready'; current: string | null; latest: string }
  | { kind: 'updating'; current: string | null; latest: string; step: number; steps: number; stepKey: string; log?: string }
  | { kind: 'done'; current: string | null; latest: string }
  | { kind: 'error'; current: string | null; latest?: string; message: string; log?: string };

/** What the Electron preload exposes (see apps/desktop/src/preload.js). */
interface DesktopUpdaterState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'unsupported';
  version?: string | null;
  current?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string | null;
  checkedAt?: number;
}
interface DesktopBridge {
  updater?: {
    get: () => Promise<DesktopUpdaterState>;
    check: () => Promise<DesktopUpdaterState>;
    restart: () => Promise<boolean>;
    onState: (cb: (s: DesktopUpdaterState) => void) => () => void;
  };
}

const POLL_MS = 2500;
const POLL_CAP_MS = 10 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private api = inject(ApiService);

  readonly state = signal<UpdateState>({ kind: 'idle', current: null });
  /** Where the version comes from: the installed app's updater, or the API's self-update. */
  readonly mode = signal<'desktop' | 'source'>('source');
  readonly version = signal<VersionInfo | null>(null);
  readonly busy = computed(() => ['checking', 'downloading', 'updating', 'done'].includes(this.state().kind));

  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStarted = 0;

  /** Called once by the sidebar: picks the source of truth and starts listening. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const bridge = (window as unknown as { hydraDesktop?: DesktopBridge }).hydraDesktop;
    const updater = bridge?.updater;
    if (updater) {
      updater.get().then((s) => {
        // Not packaged (the shell in development): the API's git update applies instead.
        if (s.status === 'unsupported') { this.startSource(); return; }
        this.mode.set('desktop');
        this.applyDesktop(s);
        updater.onState((n) => this.applyDesktop(n));
        this.loadVersion(false);
      }).catch(() => this.startSource());
    } else {
      this.startSource();
    }
  }

  /** The user clicked the version line: ask again, now. */
  checkNow(): void {
    if (this.busy()) return;
    const updater = (window as unknown as { hydraDesktop?: DesktopBridge }).hydraDesktop?.updater;
    if (this.mode() === 'desktop' && updater) {
      this.state.set({ kind: 'checking', current: this.current() });
      updater.check().then((s) => this.applyDesktop(s)).catch(() => {});
      return;
    }
    this.state.set({ kind: 'checking', current: this.current() });
    this.loadVersion(true);
  }

  /** "Update to X" (from source): the API pulls, rebuilds and restarts; this follows it. */
  startSourceUpdate(): void {
    const st = this.state();
    if (st.kind !== 'available' && st.kind !== 'error') return;
    const latest = st.latest ?? this.version()?.latest ?? '';
    this.state.set({ kind: 'updating', current: this.current(), latest, step: 0, steps: 5, stepKey: 'fetch' });
    this.api.selfUpdate().subscribe({
      next: () => this.beginPolling(latest),
      // The API answers with a code (dirty, not_git, no_release…) the sidebar translates.
      error: (e) => this.state.set({ kind: 'error', current: this.current(), latest, message: String(e?.error?.error || e?.error?.message || e?.message || 'update_failed') }),
    });
  }

  /** "Restart and install X" (desktop): the downloaded version is applied now. */
  restartToInstall(): void {
    const updater = (window as unknown as { hydraDesktop?: DesktopBridge }).hydraDesktop?.updater;
    if (this.state().kind !== 'ready' || !updater) return;
    updater.restart().catch(() => {});
  }

  /** The action a retry means in the current mode. */
  retry(): void {
    if (this.mode() === 'desktop') this.checkNow();
    else this.loadVersion(true);
  }

  private current(): string | null { return this.version()?.current ?? null; }

  // ── From source ──

  private startSource(): void {
    this.mode.set('source');
    this.loadVersion(false);
    // Opened in the middle of an update (a reload, another tab): keep following it.
    this.api.selfUpdateStatus().subscribe({
      next: (s) => { if (s.status === 'queued' || s.status === 'running' || s.status === 'restarting') { this.applySelfUpdate(s, s.tag?.replace(/^v/, '') ?? ''); this.beginPolling(s.tag?.replace(/^v/, '') ?? ''); } },
      error: () => {},
    });
  }

  private loadVersion(refresh: boolean): void {
    this.api.getVersion(refresh).subscribe({
      next: (v) => {
        this.version.set(v);
        if (this.mode() === 'desktop') return; // the updater's state rules there
        const st = this.state();
        if (st.kind === 'updating' || st.kind === 'done') return;
        if (v.updateAvailable && v.latest) this.state.set({ kind: 'available', current: v.current, latest: v.latest });
        else this.state.set({ kind: 'idle', current: v.current, checkedAt: v.checkedAt ?? Date.now() });
      },
      error: () => { if (this.state().kind === 'checking') this.state.set({ kind: 'idle', current: this.current() }); },
    });
  }

  private beginPolling(latest: string): void {
    this.stopPolling();
    this.pollStarted = Date.now();
    this.pollTimer = setInterval(() => {
      if (Date.now() - this.pollStarted > POLL_CAP_MS) {
        this.stopPolling();
        this.state.set({ kind: 'error', current: this.current(), latest, message: 'timeout' });
        return;
      }
      this.api.selfUpdateStatus().subscribe({
        next: (s) => this.applySelfUpdate(s, latest),
        // A network error is the API restarting: keep trying, it comes back.
        error: () => {},
      });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private applySelfUpdate(s: SelfUpdateStatus, latest: string): void {
    const current = this.current();
    if (s.status === 'success') {
      this.stopPolling();
      this.state.set({ kind: 'done', current, latest });
      // The UI may be new: reload to take the updated build.
      setTimeout(() => window.location.reload(), 2500);
    } else if (s.status === 'error') {
      this.stopPolling();
      this.state.set({ kind: 'error', current, latest, message: s.error || 'update_failed', log: s.log });
    } else if (s.status === 'queued' || s.status === 'running' || s.status === 'restarting') {
      this.state.set({ kind: 'updating', current, latest, step: s.step ?? 0, steps: s.steps ?? 5, stepKey: s.stepKey ?? 'fetch', log: s.log });
    }
  }

  // ── Desktop (electron-updater) ──

  private applyDesktop(s: DesktopUpdaterState): void {
    const current = s.current ?? this.current();
    switch (s.status) {
      case 'checking': this.state.set({ kind: 'checking', current }); break;
      case 'available': this.state.set({ kind: 'downloading', current, latest: s.version ?? '', percent: 0, transferred: 0, total: 0 }); break;
      case 'downloading': this.state.set({ kind: 'downloading', current, latest: s.version ?? '', percent: s.percent ?? 0, transferred: s.transferred ?? 0, total: s.total ?? 0 }); break;
      case 'downloaded': this.state.set({ kind: 'ready', current, latest: s.version ?? '' }); break;
      case 'up-to-date': this.state.set({ kind: 'idle', current, checkedAt: s.checkedAt ?? Date.now() }); break;
      case 'error': this.state.set({ kind: 'error', current, message: s.error || 'check_failed' }); break;
      default: this.state.set({ kind: 'idle', current });
    }
  }
}

import type { Subscription } from 'rxjs';
import { Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, ChatAttachment, ModelOption, ThreeDScene, ThreeDSceneSummary } from '../../../services/api.service';
import { ComplementosService } from '../../../services/complementos.service';
import { IconComponent } from '../../icon/icon.component';
import { groupModels, modelLabel } from '../../../shared/model-groups';

// 3D: the model writes Three.js, the sandbox renders it. Same idea as
// Claude's 3D artifacts. The renderer lives in /threed/sandbox.html inside an
// <iframe sandbox="allow-scripts"> (opaque origin — generated code cannot reach
// the app); this component talks to it with postMessage guarded by a nonce.
//
// NOTE on security headers: the app serves no Content-Security-Policy today.
// If one is ever added, the sandbox needs script-src 'unsafe-inline' (its
// inline script), blob: for the Three.js module, and a frame-src that allows
// the opaque-origin frame — otherwise this plugin goes blank.

type Status = 'loading' | 'idle' | 'enhancing' | 'generating' | 'running' | 'fixing' | 'ok' | 'error';

interface Iteration {
  prompt: string;
  code: string;
  at: string;
  fixed?: number;
}

const MAX_AUTO_FIX = 2;
const CANCELLED = Symbol('cancelled');
const MODEL_KEY = 'hydra_threed_model';
const STYLE_KEY = 'hydra_threed_style';
const CLEAN_KEY = 'hydra_threed_clean';
// Style presets; the directives live in the API (THREED_STYLES). '' = none.
const STYLES = ['', 'lowpoly', 'voxel', 'stylized', 'realistic'] as const;

@Component({
  selector: 'app-three-d',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './three-d.component.html',
  styleUrl: './three-d.component.css',
})
export class ThreeDComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private complementos = inject(ComplementosService);
  private i18n = inject(TranslateService);

  frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly status = signal<Status>('loading');
  readonly error = signal('');
  readonly errorLine = signal<number | null>(null);
  readonly fixAttempt = signal(0);
  readonly stats = signal<{ meshes: number; triangles: number } | null>(null);
  readonly ready = signal(false);

  readonly prompt = signal('');
  readonly code = signal('');
  readonly codeDraft = signal('');
  readonly history = signal<Iteration[]>([]);
  // Iterations shown in full (by their timestamp); the rest are clamped to three lines.
  readonly expanded = signal<ReadonlySet<string>>(new Set());

  toggleIteration(at: string): void {
    this.expanded.update(s => { const n = new Set(s); n.has(at) ? n.delete(at) : n.add(at); return n; });
  }

  // Put a past prompt (an improved brief, say) back in the box to edit it or generate again.
  useIteration(h: Iteration): void {
    this.prompt.set(h.prompt);
    this.tab.set('prompt');
  }
  readonly reference = signal<ChatAttachment | null>(null);
  readonly uploading = signal(false);
  readonly tab = signal<'prompt' | 'code'>('prompt');
  readonly copied = signal(false);
  readonly wire = signal(false);
  /** Clean view: no grid, gradient backdrop, contact shadow (for pictures). */
  readonly clean = signal(false);
  /** The last code that failed and the error it threw, so "Keep fixing" can pick it up
   *  after the automatic attempts ran out or a fix request timed out. */
  readonly lastFailure = signal<{ prompt: string; code: string; error: string } | null>(null);
  /** Set when a failed change was rolled back to the previous working version. */
  readonly keptPrevious = signal(false);

  readonly models = signal<ModelOption[]>([]);
  readonly model = signal<string>('');
  readonly modelLabel = modelLabel;
  // Same company groups as the global model selector (Config).
  readonly groupedModels = computed(() => groupModels(this.models()));
  // The chosen model by its display name (the id of the local one is just "local-model").
  readonly modelName = computed(() => {
    const m = this.models().find(x => x.id === this.model());
    return m ? modelLabel(m.name) : this.model();
  });
  readonly isLocalModel = computed(() => {
    const m = this.models().find(x => x.id === this.model());
    return m?.provider === 'local';
  });

  readonly scenes = signal<ThreeDSceneSummary[]>([]);
  readonly sceneId = signal<string>('');
  readonly sceneName = signal<string>('');
  readonly saving = signal(false);
  readonly pendingDelete = signal<string>('');
  readonly dirty = signal(false);

  readonly hasCode = computed(() => !!this.code().trim());
  readonly busy = computed(() => ['enhancing', 'generating', 'running', 'fixing'].includes(this.status()));

  readonly styles = STYLES;
  readonly style = signal<string>('');
  // The idea as typed, kept so "Improve prompt" can be undone.
  readonly beforeEnhance = signal('');
  // The in-flight model request (generate / fix / improve): unsubscribing aborts the
  // HTTP call, and the API aborts the model call when the client goes away.
  private inFlight: Subscription | null = null;
  private rejectInFlight: ((reason: unknown) => void) | null = null;
  private statusBeforeBusy: Status = 'idle';
  // mm:ss since the current generation started (reasoning models can take minutes).
  readonly elapsed = signal('');
  private busySince = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;

  private nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private threeSource = '';
  private pendingRun: { resolve: (r: { ok: boolean; message?: string; line?: number | null }) => void } | null = null;
  private pendingExport: { resolve: (b: ArrayBuffer | null) => void } | null = null;
  private pendingSnapshot: { resolve: (d: string | null) => void } | null = null;
  private pendingPng: { resolve: (d: string | null) => void } | null = null;
  private frameLoaded = false;
  private onMessage = (e: MessageEvent) => this.handleMessage(e);

  ngOnInit(): void {
    window.addEventListener('message', this.onMessage);
    this.ticker = setInterval(() => {
      if (!this.busy()) return;
      const sec = Math.floor((Date.now() - this.busySince) / 1000);
      this.elapsed.set(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
    }, 1000);
    this.api.fetchThreeBundle().subscribe({
      next: src => { this.threeSource = src; this.initFrame(); },
      error: () => { this.status.set('error'); this.error.set(this.i18n.instant('threeD.noThree')); },
    });
    try {
      const savedStyle = localStorage.getItem(STYLE_KEY) ?? '';
      if ((STYLES as readonly string[]).includes(savedStyle)) this.style.set(savedStyle);
      this.clean.set(localStorage.getItem(CLEAN_KEY) === '1');
    } catch { /* storage unavailable */ }
    this.api.getModelsShared().subscribe({
      next: all => {
        // The catalog can list an id twice (same model under two providers); keep the first.
        const seen = new Set<string>();
        const usable = all.filter(m => !m.isImage && !m.isVideo && m.type !== 'audio' && m.type !== 'embedding' && !seen.has(m.id) && !!seen.add(m.id));
        this.models.set(usable);
        let saved = '';
        try { saved = localStorage.getItem(MODEL_KEY) ?? ''; } catch { /* storage unavailable */ }
        if (saved && usable.some(m => m.id === saved)) this.model.set(saved);
        else this.api.getConfig().subscribe(c => { if (c.defaultModel && usable.some(m => m.id === c.defaultModel)) this.model.set(c.defaultModel); });
      },
      error: () => {},
    });
    this.loadScenes();
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.ticker) clearInterval(this.ticker);
    this.inFlight?.unsubscribe(); // leaving the plugin stops the model call too
  }

  // ── Sandbox plumbing ──
  onFrameLoad(): void {
    this.frameLoaded = true;
    this.initFrame();
  }

  private initFrame(): void {
    if (!this.frameLoaded || !this.threeSource) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-surface-alt').trim() || '#1b1b2f';
    this.frame()?.nativeElement.contentWindow?.postMessage({ type: 'init', nonce: this.nonce, three: this.threeSource, bg }, '*');
  }

  private send(message: Record<string, unknown>, transfer?: Transferable[]): void {
    const win = this.frame()?.nativeElement.contentWindow;
    if (!win) return;
    win.postMessage({ ...message, nonce: this.nonce }, '*', transfer ?? []);
  }

  private handleMessage(e: MessageEvent): void {
    if (e.source !== this.frame()?.nativeElement.contentWindow) return;
    const d = e.data ?? {};
    switch (d.type) {
      case 'ready':
        this.ready.set(true);
        if (this.status() === 'loading') this.status.set('idle');
        if (this.clean()) this.send({ type: 'view', mode: 'clean', value: true });
        if (this.code()) this.runCode(this.code());
        break;
      case 'fatal':
        this.status.set('error');
        this.error.set(String(d.message ?? ''));
        break;
      case 'ok':
        this.stats.set(d.stats ?? null);
        this.pendingRun?.resolve({ ok: true });
        this.pendingRun = null;
        break;
      case 'error':
        if (this.pendingRun) { this.pendingRun.resolve({ ok: false, message: String(d.message ?? ''), line: d.line ?? null }); this.pendingRun = null; }
        else { this.status.set('error'); this.error.set(String(d.message ?? '')); this.errorLine.set(d.line ?? null); }
        break;
      case 'glb':
        this.pendingExport?.resolve(d.buffer ?? null);
        this.pendingExport = null;
        break;
      case 'snapshot':
        this.pendingSnapshot?.resolve(d.dataUrl ?? null);
        this.pendingSnapshot = null;
        break;
      case 'png':
        this.pendingPng?.resolve(d.dataUrl ?? null);
        this.pendingPng = null;
        break;
    }
  }

  private runCode(code: string): Promise<{ ok: boolean; message?: string; line?: number | null }> {
    return new Promise(resolve => {
      this.pendingRun = { resolve };
      this.send({ type: 'run', code });
      setTimeout(() => { if (this.pendingRun?.resolve === resolve) { this.pendingRun = null; resolve({ ok: false, message: 'timeout' }); } }, 15_000);
    });
  }

  private snapshot(): Promise<string | null> {
    return new Promise(resolve => {
      this.pendingSnapshot = { resolve };
      this.send({ type: 'snapshot' });
      setTimeout(() => { if (this.pendingSnapshot?.resolve === resolve) { this.pendingSnapshot = null; resolve(null); } }, 5_000);
    });
  }

  // ── Generate / iterate / self-heal ──
  onModelChange(id: string): void {
    this.model.set(id);
    try { localStorage.setItem(MODEL_KEY, id); } catch { /* storage unavailable */ }
  }

  onStyleChange(value: string): void {
    this.style.set(value);
    this.dirty.set(true);
    try { localStorage.setItem(STYLE_KEY, value); } catch { /* storage unavailable */ }
  }

  // Turns the short idea into a build brief (same model, no code yet). The user
  // reads it, edits it if needed, and only then generates.
  enhance(): void {
    const idea = this.prompt().trim();
    if (!idea || this.busy()) return;
    const previous = this.status();
    this.busySince = Date.now();
    this.elapsed.set('0:00');
    this.status.set('enhancing');
    this.error.set('');
    this.errorLine.set(null);
    this.statusBeforeBusy = previous === 'error' ? 'idle' : previous;
    this.inFlight = this.api.enhance3d({ prompt: idea, model: this.model() || undefined, style: this.style() || undefined, imagePath: this.reference()?.path }).subscribe({
      next: r => {
        this.inFlight = null;
        this.beforeEnhance.set(idea);
        this.prompt.set(r.prompt);
        this.status.set(previous === 'error' ? 'idle' : previous);
      },
      error: err => { this.inFlight = null; this.fail(this.describe(err)); },
    });
  }

  // Cancel button on the working badge.
  cancel(): void {
    if (!this.inFlight) return;
    this.inFlight.unsubscribe();
    this.inFlight = null;
    const reject = this.rejectInFlight; this.rejectInFlight = null;
    this.error.set('');
    this.errorLine.set(null);
    this.status.set(this.hasCode() ? 'ok' : this.statusBeforeBusy === 'loading' ? 'loading' : 'idle');
    reject?.(CANCELLED);
  }

  undoEnhance(): void {
    if (!this.beforeEnhance()) return;
    this.prompt.set(this.beforeEnhance());
    this.beforeEnhance.set('');
  }

  async generate(): Promise<void> {
    const prompt = this.prompt().trim();
    if (!prompt || this.busy() || !this.ready()) return;
    const iterating = this.hasCode();
    const nameSource = this.beforeEnhance() || prompt;
    this.beforeEnhance.set('');
    this.busySince = Date.now();
    this.elapsed.set('0:00');
    this.status.set('generating');
    this.error.set('');
    this.errorLine.set(null);
    this.fixAttempt.set(0);
    this.lastFailure.set(null);
    this.keptPrevious.set(false);
    let code: string;
    try {
      code = await this.requestCode({ prompt, code: iterating ? this.code() : undefined });
    } catch (err: unknown) {
      if (err !== CANCELLED) this.fail(this.describe(err));
      return;
    }
    await this.applyGenerated(code, prompt, nameSource);
  }

  // Runs the code; on a runtime error asks the model to fix it, up to MAX_AUTO_FIX times.
  private async applyGenerated(code: string, prompt: string, nameSource = prompt): Promise<void> {
    let current = code;
    for (let attempt = 0; attempt <= MAX_AUTO_FIX; attempt++) {
      this.status.set('running');
      this.code.set(current);
      this.codeDraft.set(current);
      const r = await this.runCode(current);
      if (r.ok) {
        this.history.update(h => [...h, { prompt, code: current, at: new Date().toISOString(), fixed: attempt || undefined }]);
        // Default name: the first words of the first prompt.
        if (!this.sceneName().trim()) this.sceneName.set(nameSource.split(/\s+/).slice(0, 6).join(' ').slice(0, 60).replace(/[\s,;:.]+$/, ''));
        this.prompt.set('');
        this.dirty.set(true);
        this.status.set('ok');
        this.error.set('');
        this.errorLine.set(null);
        if (this.sceneId()) void this.save();
        return;
      }
      const message = r.message ?? 'error';
      const runtimeError = r.line ? `${message} (line ${r.line})` : message;
      if (attempt === MAX_AUTO_FIX) {
        await this.failWithRecovery(message, r.line ?? null, { prompt, code: current, error: runtimeError });
        return;
      }
      this.status.set('fixing');
      this.fixAttempt.set(attempt + 1);
      this.error.set(message);
      this.errorLine.set(r.line ?? null);
      try {
        current = await this.requestCode({ prompt, code: current, error: runtimeError });
      } catch (err: unknown) {
        // A fix that timed out or was cancelled must not cost the work done so far.
        await this.failWithRecovery(err === CANCELLED ? null : this.describe(err), null, { prompt, code: current, error: runtimeError });
        return;
      }
    }
  }

  private requestCode(body: { prompt: string; code?: string; error?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      this.rejectInFlight = reject;
      this.inFlight = this.api.generate3d({ ...body, model: this.model() || undefined, style: this.style() || undefined, imagePath: this.reference()?.path }).subscribe({
        next: r => { this.inFlight = null; this.rejectInFlight = null; resolve(r.code); },
        error: err => { this.inFlight = null; this.rejectInFlight = null; reject(err); },
      });
    });
  }

  private describe(err: unknown): string {
    const e = err as { error?: { error?: string }; message?: string };
    return e?.error?.error || e?.message || 'error';
  }

  /**
   * A change that could not be made to work: keep what the user had. With a previous
   * working version (an iteration), that version runs again; on a first generation the
   * partial render stays. Either way "Keep fixing" can resume from the failing code.
   * message = null: cancelled by the user (no error to show).
   */
  private async failWithRecovery(message: string | null, line: number | null, failure: { prompt: string; code: string; error: string }): Promise<void> {
    this.lastFailure.set(failure);
    const previous = this.history().at(-1)?.code;
    if (previous) {
      this.code.set(previous);
      this.codeDraft.set(previous);
      await this.runCode(previous);
      this.keptPrevious.set(true);
    }
    if (message === null) {
      this.status.set(previous ? 'ok' : 'error');
      this.error.set(previous ? '' : failure.error);
      this.errorLine.set(null);
      return;
    }
    this.status.set('error');
    this.error.set(message);
    this.errorLine.set(line);
    if (!previous) this.stats.set(null);
  }

  // Resumes the self-heal loop from the last failing code (after the automatic
  // attempts ran out, a fix request timed out, or the user cancelled one).
  async keepFixing(): Promise<void> {
    const f = this.lastFailure();
    if (!f || this.busy() || !this.ready()) return;
    this.busySince = Date.now();
    this.elapsed.set('0:00');
    this.status.set('fixing');
    this.fixAttempt.set(1);
    this.error.set('');
    this.errorLine.set(null);
    this.keptPrevious.set(false);
    let code: string;
    try {
      code = await this.requestCode({ prompt: f.prompt, code: f.code, error: f.error });
    } catch (err: unknown) {
      await this.failWithRecovery(err === CANCELLED ? null : this.describe(err), null, f);
      return;
    }
    this.lastFailure.set(null);
    await this.applyGenerated(code, f.prompt);
  }

  private fail(message: string, line: number | null = null): void {
    this.status.set('error');
    this.error.set(message);
    this.errorLine.set(line);
    this.stats.set(null);
  }

  // Manual edit in the Code tab → run it as-is (no model involved).
  async applyDraft(): Promise<void> {
    const code = this.codeDraft();
    if (!code.trim() || this.busy() || !this.ready()) return;
    this.status.set('running');
    this.code.set(code);
    const r = await this.runCode(code);
    if (r.ok) { this.status.set('ok'); this.error.set(''); this.errorLine.set(null); this.dirty.set(true); }
    else this.fail(r.message ?? 'error', r.line ?? null);
  }

  newScene(): void {
    if (this.busy()) return;
    this.sceneId.set('');
    this.sceneName.set('');
    this.prompt.set('');
    this.code.set('');
    this.codeDraft.set('');
    this.history.set([]);
    this.reference.set(null);
    this.beforeEnhance.set('');
    this.stats.set(null);
    this.error.set('');
    this.lastFailure.set(null);
    this.keptPrevious.set(false);
    this.dirty.set(false);
    this.status.set(this.ready() ? 'idle' : 'loading');
    this.send({ type: 'run', code: '' });
  }

  // ── Reference image ──
  pickReference(): void { this.fileInput()?.nativeElement.click(); }

  onReferenceSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    this.uploading.set(true);
    this.api.uploadChatFile(file).subscribe({
      next: att => { this.reference.set(att); this.uploading.set(false); },
      error: () => this.uploading.set(false),
    });
  }

  referenceUrl(): string {
    const r = this.reference();
    return r ? this.api.storageUrl(r.path.replace(/^storage\//, '')) : '';
  }

  // ── View ──
  toggleWire(): void { this.wire.update(v => !v); this.send({ type: 'view', mode: 'wireframe', value: this.wire() }); }
  resetView(): void { this.send({ type: 'view', mode: 'reset' }); }
  toggleClean(): void {
    this.clean.update(v => !v);
    this.send({ type: 'view', mode: 'clean', value: this.clean() });
    try { localStorage.setItem(CLEAN_KEY, this.clean() ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  // The canvas as shown (clean view or not), full size, as <scene name>.png.
  async savePng(): Promise<void> {
    if (!this.hasCode() || this.busy()) return;
    const dataUrl = await new Promise<string | null>(resolve => {
      this.pendingPng = { resolve };
      this.send({ type: 'png' });
      setTimeout(() => { if (this.pendingPng?.resolve === resolve) { this.pendingPng = null; resolve(null); } }, 10_000);
    });
    if (!dataUrl) { this.fail(this.i18n.instant('threeD.pngFailed')); return; }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${(this.sceneName() || 'hydraops-3d').replace(/[^\w\-]+/g, '_')}.png`;
    a.click();
  }

  // ── Export ──
  async exportGlb(): Promise<void> {
    if (!this.hasCode() || this.busy()) return;
    const buffer = await new Promise<ArrayBuffer | null>(resolve => {
      this.pendingExport = { resolve };
      this.send({ type: 'export' });
      setTimeout(() => { if (this.pendingExport?.resolve === resolve) { this.pendingExport = null; resolve(null); } }, 20_000);
    });
    if (!buffer) { this.fail(this.i18n.instant('threeD.exportFailed')); return; }
    const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(this.sceneName() || 'hydraops-3d').replace(/[^\w\-]+/g, '_')}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  copyCode(): void {
    navigator.clipboard?.writeText(this.code()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  // ── Scenes (storage/scenes/<id>.json on the server) ──
  loadScenes(): void {
    this.api.list3dScenes().subscribe({ next: s => this.scenes.set(s), error: () => {} });
  }

  async save(): Promise<void> {
    if (!this.hasCode() || this.saving()) return;
    const id = this.sceneId() || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = this.sceneName().trim() || this.defaultName();
    this.saving.set(true);
    const thumb = this.ready() ? await this.snapshot() : null;
    const scene: ThreeDScene = { id, name, prompt: this.history().at(-1)?.prompt ?? this.prompt(), code: this.code(), model: this.model(), style: this.style(), history: this.history(), thumb: thumb ?? undefined };
    this.api.save3dScene(id, scene).subscribe({
      next: () => { this.sceneId.set(id); this.sceneName.set(name); this.saving.set(false); this.dirty.set(false); this.loadScenes(); },
      error: () => this.saving.set(false),
    });
  }

  openScene(id: string): void {
    if (this.busy()) return;
    this.api.get3dScene(id).subscribe({
      next: s => {
        this.sceneId.set(s.id);
        this.sceneName.set(s.name);
        this.code.set(s.code);
        this.codeDraft.set(s.code);
        this.history.set(s.history ?? []);
        this.prompt.set('');
        this.reference.set(null);
        this.dirty.set(false);
        if (s.model && this.models().some(m => m.id === s.model)) this.model.set(s.model);
        this.style.set((STYLES as readonly string[]).includes(s.style ?? '') ? (s.style ?? '') : '');
        this.beforeEnhance.set('');
        if (this.ready()) void this.runCode(s.code).then(r => this.status.set(r.ok ? 'ok' : 'error'));
      },
      error: () => {},
    });
  }

  askDelete(id: string): void { this.pendingDelete.set(id); }
  cancelDelete(): void { this.pendingDelete.set(''); }

  deleteScene(id: string): void {
    this.api.delete3dScene(id).subscribe({
      next: () => {
        this.pendingDelete.set('');
        if (this.sceneId() === id) { this.sceneId.set(''); this.sceneName.set(''); }
        this.loadScenes();
      },
      error: () => this.pendingDelete.set(''),
    });
  }

  thumbUrl(s: ThreeDSceneSummary): string {
    return s.thumb ? this.api.storageUrl(`scenes/${s.id}.png?v=${encodeURIComponent(s.updatedAt)}`) : '';
  }

  private defaultName(): string {
    const p = (this.history().at(-1)?.prompt ?? this.prompt()).trim();
    return p.length > 40 ? p.slice(0, 37).trimEnd() + '…' : p || '3D';
  }

  back(): void { this.complementos.openHub(); }
}

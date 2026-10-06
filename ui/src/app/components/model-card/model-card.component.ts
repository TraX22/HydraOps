import { Component, ElementRef, HostListener, Input, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, ResultFile } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// A 3D model a task produced, under the reply that delivered it: a card with its name and
// size, and a viewer that opens only when asked (models are tens of megabytes; nothing is
// downloaded until then). The model is drawn by /threed/viewer.html inside an
// <iframe sandbox="allow-scripts">: an opaque origin, so a model file, whatever it
// contains, cannot reach the app. This component fetches the file and Three.js and hands
// both over with postMessage, guarded by a nonce.
//
// The app sets no CSP today. If one is ever added, this frame needs the same allowances
// as the 3D plugin's (see three-d.component.ts).

type Phase = 'card' | 'loading' | 'viewer' | 'error';
interface ModelStats { triangles: number; vertices: number; textures: [number, number][]; size: [number, number, number] }

// Above this the viewer does not try: the browser would need several times the file's size in memory.
const MAX_VIEW_BYTES = 400 * 1024 * 1024;

@Component({
  selector: 'app-model-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './model-card.component.html',
  styleUrl: './model-card.component.css',
})
export class ModelCardComponent implements OnDestroy {
  @Input({ required: true }) file!: ResultFile;

  private api = inject(ApiService);
  private i18n = inject(TranslateService);
  private frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  readonly phase = signal<Phase>('card');
  readonly loaded = signal(0);
  readonly error = signal('');
  readonly stats = signal<ModelStats | null>(null);
  readonly wire = signal(false);
  readonly expanded = signal(false);
  /** Loading reached the point where the frame draws: the bar gives way to the canvas. */
  readonly drawing = computed(() => this.phase() === 'viewer');

  private nonce = '';
  private three = '';
  private buffer: ArrayBuffer | null = null;
  private frameLoaded = false;
  private frameReady = false;
  private abort: AbortController | null = null;
  private onMessage = (e: MessageEvent) => this.handleMessage(e);

  get url(): string { return this.api.storageUrl(this.file.path); }

  // ── What the card says ──
  private get locale(): string { return this.i18n.currentLang() || 'en'; }
  private num(n: number, digits = 0): string {
    // 'always': Spanish and others leave four-digit numbers ungrouped by default (9940, not 9.940).
    return new Intl.NumberFormat(this.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'always' } as Intl.NumberFormatOptions).format(n);
  }
  mb(bytes: number): string { return this.num(bytes / 1024 / 1024, 1); }
  get triangles(): string { return this.num(this.stats()?.triangles ?? this.file.triangles ?? 0); }
  get hasTriangles(): boolean { return (this.stats()?.triangles ?? this.file.triangles ?? 0) > 0; }
  get vertices(): string { return this.num(this.stats()?.vertices ?? 0); }
  get textureCount(): number { return this.stats()?.textures.length ?? 0; }
  /** "2 × 4096, 1 × 2048": how many textures of each size, largest first. */
  get textureDetail(): string {
    const bySize = new Map<number, number>();
    for (const [w, h] of this.stats()?.textures ?? []) { const s = Math.max(w, h); bySize.set(s, (bySize.get(s) ?? 0) + 1); }
    return [...bySize.entries()].sort((a, b) => b[0] - a[0]).map(([s, n]) => `${n} × ${s}`).join(', ');
  }
  get dimensions(): string {
    const s = this.stats()?.size;
    if (!s) return '';
    const digits = Math.max(...s) >= 100 ? 0 : Math.max(...s) >= 10 ? 1 : 2;
    return s.map((v) => this.num(v, digits)).join(' × ');
  }

  // ── Opening the viewer ──
  async open(): Promise<void> {
    if (this.phase() === 'loading' || this.phase() === 'viewer') return;
    if (this.file.size > MAX_VIEW_BYTES) return this.fail('tooLarge');
    this.reset();
    this.phase.set('loading');
    this.nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.addEventListener('message', this.onMessage);
    this.abort = new AbortController();
    try {
      const [three, buffer] = await Promise.all([
        firstValueFrom(this.api.fetchThreeBundle()),
        this.download(this.abort.signal),
      ]);
      if (this.phase() !== 'loading') return; // closed meanwhile
      this.three = three;
      this.buffer = buffer;
      this.initFrame();
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      this.fail('load');
    }
  }

  private async download(signal: AbortSignal): Promise<ArrayBuffer> {
    const res = await fetch(this.url, { signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      this.loaded.set(total);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out.buffer;
  }

  onFrameLoad(): void {
    this.frameLoaded = true;
    this.initFrame();
  }

  private initFrame(): void {
    const win = this.frame()?.nativeElement.contentWindow;
    if (!win || !this.frameLoaded || !this.three) return;
    const css = getComputedStyle(document.documentElement);
    const colors = { grid: css.getPropertyValue('--text-muted').trim() || '#8b8fa8', wire: css.getPropertyValue('--accent').trim() || '#818cf8' };
    win.postMessage({ type: 'init', nonce: this.nonce, three: this.three, colors }, '*');
  }

  private send(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.frame()?.nativeElement.contentWindow?.postMessage({ ...message, nonce: this.nonce }, '*', transfer);
  }

  private handleMessage(e: MessageEvent): void {
    if (e.source !== this.frame()?.nativeElement.contentWindow) return;
    const d = e.data ?? {};
    if (d.type === 'ready' && !this.frameReady) {
      this.frameReady = true;
      this.three = ''; // the frame has it now
      const buffer = this.buffer;
      this.buffer = null;
      if (buffer) this.send({ type: 'load', buffer }, [buffer]);
    } else if (d.type === 'loaded' && d.stats) {
      const s = d.stats as Partial<ModelStats>;
      this.stats.set({
        triangles: Number(s.triangles) || 0,
        vertices: Number(s.vertices) || 0,
        textures: Array.isArray(s.textures) ? s.textures.filter((t) => Array.isArray(t)).map((t) => [Number(t[0]) || 0, Number(t[1]) || 0] as [number, number]) : [],
        size: Array.isArray(s.size) && s.size.length === 3 ? (s.size.map((v) => Number(v) || 0) as [number, number, number]) : [0, 0, 0],
      });
      this.phase.set('viewer');
    } else if (d.type === 'error') {
      const m = String(d.message ?? '');
      this.fail(m === 'webgl_unavailable' ? 'webgl' : this.phase() === 'loading' ? 'format' : 'load');
    }
  }

  private fail(code: 'load' | 'format' | 'webgl' | 'tooLarge'): void {
    this.reset();
    this.error.set(code);
    this.phase.set('error');
  }

  // ── The viewer's buttons ──
  resetView(): void { this.send({ type: 'view', mode: 'reset' }); }
  toggleWire(): void {
    this.wire.update((w) => !w);
    this.send({ type: 'view', mode: 'wire', value: this.wire() });
  }
  toggleExpanded(): void { this.expanded.update((v) => !v); }

  close(): void {
    this.reset();
    this.phase.set('card');
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.expanded()) this.expanded.set(false);
  }

  private reset(): void {
    window.removeEventListener('message', this.onMessage);
    this.abort?.abort();
    this.abort = null;
    this.three = '';
    this.buffer = null;
    this.frameLoaded = false;
    this.frameReady = false;
    this.loaded.set(0);
    this.error.set('');
    this.stats.set(null);
    this.wire.set(false);
    this.expanded.set(false);
  }

  ngOnDestroy(): void { this.reset(); }
}

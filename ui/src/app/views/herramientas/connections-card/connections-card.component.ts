import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { IconComponent } from '../../../components/icon/icon.component';
import { ApiService, CatalogConnection, ConnectionPreview, ConnectionServer, McpToolClass } from '../../../services/api.service';

// One row of the "Available" table: a catalog connection and what installing it would do.
interface AvailableRow {
  preset: CatalogConnection;
  /** install · installed · update · modified (installed, then edited by hand) · taken (a server of the user's has that name) */
  state: 'install' | 'installed' | 'update' | 'modified' | 'taken';
}

interface PreviewState {
  name: string;
  title: string;
  version: string;
  loading: boolean;
  error?: string;
  data?: ConnectionPreview;
}

/**
 * Herramientas → Connections. MCP servers ready to use, from the catalog (the presets of
 * the HydraOps-Skills repository): what each one needs on this computer, what each of
 * its tools does, install / update / remove. The servers the user configured by hand in
 * Add-ons are listed with their state, and left alone.
 */
@Component({
  selector: 'app-connections-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './connections-card.component.html',
  // The card vocabulary (tables, chips, buttons, drawer) is the Skills card's.
  styleUrls: ['../skills-card/skills-card.component.css', './connections-card.component.css'],
})
export class ConnectionsCardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private translate = inject(TranslateService);

  servers = signal<ConnectionServer[]>([]);
  catalog = signal<CatalogConnection[]>([]);
  catalogError = signal(false);
  catalogLoading = signal(false);
  filter = signal('');
  busy = signal<string | null>(null);
  error = signal('');
  notice = signal<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  preview = signal<PreviewState | null>(null);
  private timers: ReturnType<typeof setTimeout>[] = [];

  private norm = (v: string) => v.replace(/\s+/g, '_').toLowerCase();

  available = computed<AvailableRow[]>(() => {
    const servers = this.servers();
    const q = this.filter().trim().toLowerCase();
    return this.catalog()
      .filter(p => !q || [p.name, p.title, p.description].some(v => v.toLowerCase().includes(q)))
      .map(preset => {
        const mine = servers.find(s => s.preset?.name === preset.name);
        let state: AvailableRow['state'] = 'install';
        if (mine) state = mine.preset!.modified ? 'modified' : mine.preset!.version === preset.version ? 'installed' : 'update';
        else if (servers.some(s => !s.preset && this.norm(s.name) === this.norm(preset.title))) state = 'taken';
        return { preset, state };
      });
  });

  private catalogVersion = computed(() => new Map(this.catalog().map(p => [p.name, p.version])));

  ngOnInit(): void {
    this.reload();
    this.loadCatalog(false);
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearTimeout);
  }

  reload(): void {
    this.api.getConnections().subscribe({
      next: r => this.servers.set(r.servers),
      error: () => this.error.set(this.translate.instant('herramientas.connections.loadError')),
    });
  }

  loadCatalog(refresh: boolean): void {
    this.catalogLoading.set(true);
    this.api.getConnectionsCatalog(refresh).subscribe({
      next: r => { this.catalog.set(r.presets); this.catalogError.set(false); this.catalogLoading.set(false); },
      error: () => { this.catalogError.set(true); this.catalogLoading.set(false); },
    });
  }

  newerVersion(s: ConnectionServer): string | null {
    if (!s.preset) return null;
    const v = this.catalogVersion().get(s.preset.name);
    return v && v !== s.preset.version ? v : null;
  }

  /** The state column: a dot and what it means in plain words. */
  stateKind(s: ConnectionServer): 'ok' | 'wait' | 'off' | 'unknown' {
    if (s.state === 'connected') return 'ok';
    if (s.state === 'off') return 'off';
    if (s.state === 'connecting' || s.state === 'failed' || s.state === 'timeout') return 'wait';
    return 'unknown';
  }

  stateText(s: ConnectionServer): string {
    const t = (k: string, p?: object) => this.translate.instant('herramientas.connections.state.' + k, p);
    if (s.state === 'connected') return t(s.toolCount === 1 ? 'connectedOne' : 'connected', { n: s.toolCount });
    if (s.state === 'off') return t('off');
    if (s.state === 'connecting') return t('connecting');
    if (s.state === 'failed' || s.state === 'timeout') return t('waiting');
    // No worker reports it: nobody was given it yet, or the app has just started.
    return t(s.agents.length ? 'starting' : 'unused');
  }

  // ── Actions ──

  install(name: string, opts: { replace?: boolean } = {}): void {
    if (this.busy()) return;
    this.busy.set(name);
    this.error.set('');
    this.notice.set(null);
    this.api.installConnection(name, !!opts.replace).subscribe({
      next: r => {
        this.busy.set(null);
        this.preview.set(null);
        this.notice.set(r.launcherFound === false
          ? { kind: 'warn', text: this.translate.instant('herramientas.connections.installedMissing', { name: r.server }) }
          : { kind: 'ok', text: this.translate.instant('herramientas.connections.installedOk', { name: r.server }) });
        this.reload();
        // The workers pick the change up on their heartbeat and connect: look again a few times.
        for (const ms of [6000, 15000, 30000]) this.timers.push(setTimeout(() => this.reload(), ms));
      },
      error: err => {
        this.busy.set(null);
        const code = err?.error?.error;
        this.error.set(this.translate.instant(
          code === 'name_taken' ? 'herramientas.connections.takenWarn' : code === 'modified' ? 'herramientas.connections.modifiedWarn' : 'herramientas.connections.installError'));
      },
    });
  }

  /** Install / update / replace from the preview, asking first when it overwrites something of the user's. */
  confirmFromPreview(p: PreviewState): void {
    const c = p.data?.conflict;
    if (c === 'manual' && !confirm(this.translate.instant('herramientas.connections.replaceConfirm', { name: p.title }))) return;
    if (c === 'modified' && !confirm(this.translate.instant('herramientas.connections.modifiedConfirm', { name: p.title }))) return;
    this.install(p.name, { replace: c === 'manual' || c === 'modified' });
  }

  remove(s: ConnectionServer): void {
    if (this.busy() || !s.preset) return;
    if (!confirm(this.translate.instant('herramientas.connections.removeConfirm', { name: s.name }))) return;
    this.busy.set(s.name);
    this.api.removeConnection(s.name).subscribe({
      next: () => { this.busy.set(null); this.reload(); },
      error: () => { this.busy.set(null); this.error.set(this.translate.instant('herramientas.connections.removeError', { name: s.name })); },
    });
  }

  // ── Preview ──

  open(name: string, title: string, version: string): void {
    this.preview.set({ name, title, version, loading: true });
    this.api.previewConnection(name).subscribe({
      next: data => this.patchPreview({ loading: false, data, version: data.preset.version }),
      error: () => this.patchPreview({ loading: false, error: this.translate.instant('herramientas.connections.catalogError') }),
    });
  }

  private patchPreview(part: Partial<PreviewState>): void {
    const p = this.preview();
    if (p) this.preview.set({ ...p, ...part });
  }

  closePreview(): void { this.preview.set(null); }

  tools(p: PreviewState): { name: string; cls: McpToolClass }[] {
    const risk = p.data?.preset.toolRisk ?? {};
    const order: McpToolClass[] = ['neutral', 'read', 'acts', 'both'];
    return Object.entries(risk).map(([name, cls]) => ({ name, cls })).sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.name.localeCompare(b.name));
  }

  classesUsed(p: PreviewState): McpToolClass[] {
    const used = new Set(Object.values(p.data?.preset.toolRisk ?? {}));
    return (['neutral', 'read', 'acts', 'both'] as McpToolClass[]).filter(c => used.has(c));
  }

  /** What the preview's main button does, or null when there is nothing to do. */
  actionLabel(p: PreviewState): string | null {
    switch (p.data?.conflict) {
      case 'none': return 'herramientas.connections.install';
      case 'update': return 'herramientas.connections.update';
      case 'manual': return 'herramientas.connections.replace';
      case 'modified': return 'herramientas.connections.update';
      default: return null;
    }
  }
}

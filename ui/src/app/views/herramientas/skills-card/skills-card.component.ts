import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { IconComponent } from '../../../components/icon/icon.component';
import { ApiService, CatalogSkill, HeldAction, InstalledSkill, SkillPreview, SkillsState } from '../../../services/api.service';

// One row of the "Available" table: a catalog skill and what installing it would do.
interface AvailableRow {
  skill: CatalogSkill;
  state: 'install' | 'installed' | 'update' | 'taken';
}

// The side panel that shows a skill's files (and the safety scan) before a decision.
interface PreviewState {
  title: string;
  version?: string;
  author?: string;
  loading: boolean;
  error?: string;
  data?: SkillPreview;
  file: string;
  /** What the footer offers: install / update from the catalog, or decide a pending one. */
  action?: { kind: 'install' | 'update'; name: string } | { kind: 'pending'; held: HeldAction };
}

/**
 * Herramientas → Skills. One card: who may use / create skills (their tools.md),
 * the catalog (the HydraOps-Skills repository) and what is installed on this
 * computer, including the skills agents proposed, which wait here (and in the chat)
 * for the user's approval. Each table shows five rows and scrolls past that.
 */
@Component({
  selector: 'app-skills-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './skills-card.component.html',
  styleUrl: './skills-card.component.css',
})
export class SkillsCardComponent implements OnInit {
  private api = inject(ApiService);
  private translate = inject(TranslateService);

  state = signal<SkillsState | null>(null);
  catalog = signal<CatalogSkill[]>([]);
  catalogError = signal(false);
  catalogLoading = signal(false);
  filter = signal('');
  busy = signal<string | null>(null);
  error = signal('');
  preview = signal<PreviewState | null>(null);

  users = computed(() => (this.state()?.agents ?? []).filter(a => a.canUse));
  creators = computed(() => (this.state()?.agents ?? []).filter(a => a.canCreate));

  available = computed<AvailableRow[]>(() => {
    const installed = new Map((this.state()?.installed ?? []).map(s => [s.name, s]));
    const q = this.filter().trim().toLowerCase();
    return this.catalog()
      .filter(s => !q || [s.name, s.description, s.author].some(v => v.toLowerCase().includes(q)))
      .map(skill => {
        const mine = installed.get(skill.name);
        let state: AvailableRow['state'] = 'install';
        if (mine) state = mine.source !== 'catalog' ? 'taken' : mine.version === skill.version ? 'installed' : 'update';
        return { skill, state };
      });
  });

  private catalogVersion = computed(() => new Map(this.catalog().map(s => [s.name, s.version])));

  ngOnInit(): void {
    this.reload();
    this.loadCatalog(false);
  }

  reload(): void {
    this.api.getSkills().subscribe({ next: s => this.state.set(s), error: () => this.error.set(this.translate.instant('herramientas.skills.loadError')) });
  }

  loadCatalog(refresh: boolean): void {
    this.catalogLoading.set(true);
    this.api.getSkillsCatalog(refresh).subscribe({
      next: r => { this.catalog.set(r.skills); this.catalogError.set(false); this.catalogLoading.set(false); },
      error: () => { this.catalogError.set(true); this.catalogLoading.set(false); },
    });
  }

  toggleEnabled(): void {
    const s = this.state();
    if (!s) return;
    const enabled = !s.enabled;
    this.state.set({ ...s, enabled });
    this.api.setSkillsEnabled(enabled).subscribe();
  }

  newerVersion(s: InstalledSkill): string | null {
    if (s.source !== 'catalog') return null;
    const v = this.catalogVersion().get(s.name);
    return v && v !== s.version ? v : null;
  }

  sourceLabel(s: InstalledSkill): string {
    if (s.source === 'agent') return this.translate.instant('herramientas.skills.byAgent', { agent: this.agentName(s.agentId) });
    return this.translate.instant(s.source === 'catalog' ? 'herramientas.skills.fromCatalog' : 'herramientas.skills.manual');
  }

  agentName(id?: string): string {
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : '?';
  }

  pendingName(a: HeldAction): string { return String(a.args?.['name'] ?? '?'); }
  pendingDescription(a: HeldAction): string { return String(a.args?.['description'] ?? ''); }

  // ── Actions ──

  install(name: string): void {
    if (this.busy()) return;
    this.busy.set(name);
    this.error.set('');
    this.api.installCatalogSkill(name).subscribe({
      next: () => { this.busy.set(null); this.preview.set(null); this.reload(); },
      error: err => {
        this.busy.set(null);
        const code = err?.error?.error;
        this.error.set(this.translate.instant(code === 'name_taken' ? 'herramientas.skills.nameTaken' : 'herramientas.skills.installError', { name }));
      },
    });
  }

  remove(s: InstalledSkill): void {
    if (this.busy()) return;
    if (!confirm(this.translate.instant('herramientas.skills.deleteConfirm', { name: s.name }))) return;
    this.busy.set(s.name);
    this.api.deleteSkill(s.name).subscribe({
      next: () => { this.busy.set(null); this.reload(); },
      error: () => { this.busy.set(null); this.error.set(this.translate.instant('herramientas.skills.deleteError', { name: s.name })); },
    });
  }

  decide(a: HeldAction, what: 'approve' | 'reject'): void {
    if (this.busy()) return;
    this.busy.set(a.id);
    const call = what === 'approve' ? this.api.approveHeldAction(a.id) : this.api.rejectHeldAction(a.id);
    call.subscribe({
      // Approving hands the call to the agent's worker, which writes the skill a moment later.
      next: () => { this.busy.set(null); this.preview.set(null); this.reload(); if (what === 'approve') setTimeout(() => this.reload(), 2500); },
      error: () => { this.busy.set(null); this.reload(); },
    });
  }

  // ── Preview ──

  previewCatalog(row: AvailableRow): void {
    const s = row.skill;
    const action = row.state === 'install' || row.state === 'update' ? { kind: row.state, name: s.name } as const : undefined;
    this.preview.set({ title: s.name, version: s.version, author: s.author, loading: true, file: 'SKILL.md', action });
    this.api.previewCatalogSkill(s.name).subscribe({
      next: data => this.patchPreview({ loading: false, data }),
      error: () => this.patchPreview({ loading: false, error: this.translate.instant('herramientas.skills.catalogError') }),
    });
  }

  previewInstalled(s: InstalledSkill): void {
    this.preview.set({ title: s.name, version: s.version, author: s.author, loading: true, file: 'SKILL.md' });
    this.api.previewInstalledSkill(s.name).subscribe({
      next: data => this.patchPreview({ loading: false, data }),
      error: () => this.patchPreview({ loading: false, error: this.translate.instant('herramientas.skills.loadError') }),
    });
  }

  // A proposed skill is not on disk yet: show what the agent asked to write.
  previewPending(a: HeldAction & { findings?: SkillPreview['findings'] }): void {
    const args = a.args ?? {};
    const refs = Array.isArray(args['references']) ? (args['references'] as { path?: string; content?: string }[]) : [];
    const files = [
      { path: 'SKILL.md', content: `# ${this.pendingName(a)}\n\n> ${this.pendingDescription(a)}\n\n${String(args['instructions'] ?? '')}` },
      ...refs.map(r => ({ path: String(r.path ?? '?'), content: String(r.content ?? '') })),
    ];
    this.preview.set({
      title: this.pendingName(a), author: this.agentName(a.agentId), loading: false, file: 'SKILL.md',
      data: { files, findings: a.findings ?? [] }, action: { kind: 'pending', held: a },
    });
  }

  private patchPreview(part: Partial<PreviewState>): void {
    const p = this.preview();
    if (p) this.preview.set({ ...p, ...part });
  }

  selectFile(path: string): void { this.patchPreview({ file: path }); }
  closePreview(): void { this.preview.set(null); }

  currentContent(p: PreviewState): string {
    return p.data?.files.find(f => f.path === p.file)?.content ?? '';
  }

  highFindings(p: PreviewState) { return (p.data?.findings ?? []).filter(f => f.severity === 'high'); }
  infoFindings(p: PreviewState) { return (p.data?.findings ?? []).filter(f => f.severity === 'info'); }

  findingText(code: string): string {
    return this.translate.instant('herramientas.skills.finding.' + code);
  }
}

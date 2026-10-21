import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { IconComponent } from '../../../components/icon/icon.component';
import {
  ApiService, CatalogSkill, GitHubRepoPreview, GitHubSkillDetail, GitHubSkillPreview, HeldAction, InstalledSkill, SkillPreview, SkillsState,
} from '../../../services/api.service';

// One row of the "Available" table: a catalog skill and what installing it would do.
interface AvailableRow {
  skill: CatalogSkill;
  state: 'install' | 'installed' | 'update' | 'taken' | 'builtin';
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
  /** A skill read from GitHub: what the repository says about it, beyond its files. */
  github?: GitHubSkillDetail;
  /** What the footer offers: install / update from the catalog, install from GitHub, or decide a pending one. */
  action?: { kind: 'install' | 'update'; name: string } | { kind: 'github'; path: string } | { kind: 'pending'; held: HeldAction };
}

/** The not-installable reasons the server gives, by the start of their text, to the key that says them in the user's language. */
const REASON_KEYS: [string, string][] = [
  ['no SKILL.md', 'noSkillFile'], ['the SKILL.md has no description', 'noDescription'], ['the SKILL.md name', 'badName'],
  ['the SKILL.md says its name', 'nameMismatch'], ['too many files', 'tooManyFiles'], ['too large', 'tooLarge'],
];

/**
 * Herramientas → Skills. One card: who may use / create skills (their tools.md),
 * the box that reads skills from any public GitHub repository, the catalog (the
 * HydraOps-Skills repository) and what is installed on this computer, including
 * the skills agents proposed, which wait here (and in the chat) for the user's
 * approval. Each table shows five rows and scrolls past that.
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
  notice = signal('');
  preview = signal<PreviewState | null>(null);

  // ── GitHub: the address typed, the repository read from it, the folders chosen ──
  githubUrl = signal('');
  githubLoading = signal(false);
  githubError = signal('');
  repo = signal<GitHubRepoPreview | null>(null);
  repoFilter = signal('');
  chosen = signal<Set<string>>(new Set());

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
        if (mine) state = mine.source === 'builtin' ? 'builtin' : mine.source !== 'catalog' ? 'taken' : mine.version === skill.version ? 'installed' : 'update';
        return { skill, state };
      });
  });

  repoRows = computed<GitHubSkillPreview[]>(() => {
    const q = this.repoFilter().trim().toLowerCase();
    return (this.repo()?.skills ?? []).filter(s => !q || [s.name, s.description, s.path].some(v => v.toLowerCase().includes(q)));
  });

  chosenRows = computed(() => (this.repo()?.skills ?? []).filter(s => this.chosen().has(s.path)));
  chosenBytes = computed(() => this.chosenRows().reduce((n, s) => n + s.totalBytes, 0));

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
    if (s.source === 'builtin') return this.translate.instant('herramientas.skills.builtin');
    if (s.source === 'github') return this.translate.instant('herramientas.skills.fromGitHub', { repo: s.origin?.repo ?? 'GitHub' });
    return this.translate.instant(s.source === 'catalog' ? 'herramientas.skills.fromCatalog' : 'herramientas.skills.manual');
  }

  /** The Version column: the frontmatter's version, or for a GitHub skill without one the commit it was read at. */
  versionText(s: InstalledSkill): string {
    return s.version || (s.source === 'github' && s.origin ? s.origin.commit.slice(0, 7) : '—');
  }

  /** github: the repository folder and branch the copy came from, for the row's tooltip. */
  originTitle(s: InstalledSkill): string {
    const o = s.origin;
    if (!o) return '';
    return this.translate.instant('herramientas.skills.github.origin', { repo: o.repo, ref: o.ref, commit: o.commit.slice(0, 7), path: o.path || '/' });
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

  // ── GitHub ──

  /** Reads the address: every skill folder under it, with what each one would install. Nothing is installed here. */
  lookGitHub(): void {
    const url = this.githubUrl().trim();
    if (!url || this.githubLoading()) return;
    this.githubLoading.set(true);
    this.githubError.set('');
    this.notice.set('');
    this.api.previewGitHubSkills(url).subscribe({
      next: r => {
        this.githubLoading.set(false);
        this.repo.set(r);
        this.repoFilter.set('');
        // One skill at the address: chosen already, so one click installs it.
        const only = r.skills.length === 1 ? r.skills[0] : null;
        this.chosen.set(new Set(only && this.canChoose(only) ? [only.path] : []));
      },
      error: err => { this.githubLoading.set(false); this.repo.set(null); this.githubError.set(this.githubErrorText(err)); },
    });
  }

  closeRepo(): void { this.repo.set(null); this.chosen.set(new Set()); }

  canChoose(s: GitHubSkillPreview): boolean { return s.installable && s.installed !== 'same'; }
  isChosen(path: string): boolean { return this.chosen().has(path); }

  toggleChosen(s: GitHubSkillPreview): void {
    if (!this.canChoose(s)) return;
    const next = new Set(this.chosen());
    if (next.has(s.path)) next.delete(s.path); else next.add(s.path);
    this.chosen.set(next);
  }

  repoUrl(r: GitHubRepoPreview): string { return `https://github.com/${r.owner}/${r.repo}`; }

  /** 221732 -> "221.732" / "221,732", as the user's language writes it. */
  starsText(n: number): string { return n.toLocaleString(this.translate.currentLang() || undefined); }

  /** The address of one skill folder, built from the parsed repository (what the server expects back). */
  skillUrl(s: GitHubSkillPreview): string {
    const r = this.repo();
    if (!r) return '';
    const folder = s.path ? '/' + s.path.split('/').map(encodeURIComponent).join('/') : '';
    return `${this.repoUrl(r)}/tree/${encodeURIComponent(r.ref)}${folder}`;
  }

  /** "3 files · 24 KB": what would be written, leaving out the files that don't install. */
  fileSummary(s: GitHubSkillPreview): string {
    const installs = s.files.filter(f => f.status === 'text' || f.status === 'code' || f.status === 'script');
    const kb = Math.max(1, Math.round(s.totalBytes / 1024));
    return installs.length > 1
      ? this.translate.instant('herramientas.skills.github.filesMany', { n: installs.length, kb })
      : this.translate.instant('herramientas.skills.github.filesOne', { kb });
  }

  hasCode(s: GitHubSkillPreview): boolean { return s.files.some(f => f.status === 'code'); }
  hasScripts(s: GitHubSkillPreview): boolean { return s.files.some(f => f.status === 'script'); }

  reasonText(reason?: string): string {
    if (!reason) return '';
    const hit = REASON_KEYS.find(([start]) => reason.startsWith(start));
    return hit ? this.translate.instant('herramientas.skills.github.reason.' + hit[1]) : reason;
  }

  fileStatusText(status: string): string {
    return this.translate.instant('herramientas.skills.github.status.' + status);
  }

  /** Installs the chosen folders. A name already taken by a skill from elsewhere is replaced only after asking. */
  installChosen(paths = [...this.chosen()], replace = false, alreadyInstalled: { name: string }[] = []): void {
    const r = this.repo();
    if (!r || !paths.length || this.busy()) return;
    this.busy.set('github');
    this.error.set('');
    this.notice.set('');
    this.api.installGitHubSkills(this.githubUrl().trim(), { paths, commit: r.commit, replace }).subscribe({
      next: res => {
        this.busy.set(null);
        const ok = res.results.filter(x => x.ok);
        const taken = res.results.filter(x => !x.ok && x.error === 'name_taken');
        const failed = res.results.filter(x => !x.ok && x.error !== 'name_taken');
        // The notice counts this round and the one before it (the replacements asked for after the first round).
        const all = [...alreadyInstalled, ...ok];
        if (ok.length) {
          const done = new Set(ok.map(x => x.path));
          this.repo.set({ ...r, skills: r.skills.map(s => done.has(s.path) ? { ...s, installed: 'same' as const } : s) });
          this.chosen.set(new Set([...this.chosen()].filter(p => !done.has(p))));
          this.preview.set(null);
          this.notice.set(this.translate.instant(all.length === 1 ? 'herramientas.skills.github.installedOne' : 'herramientas.skills.github.installed', { n: all.length, name: all[0].name }));
          this.reload();
        }
        if (failed.length) this.error.set(failed.map(x => `${x.name || x.path || '?'}: ${this.reasonText(x.error)}`).join(' · '));
        if (taken.length && !replace) {
          const names = taken.map(x => x.name).join(', ');
          if (confirm(this.translate.instant('herramientas.skills.github.replaceConfirm', { names }))) {
            this.installChosen(taken.map(x => x.path!), true, all);
          }
        }
      },
      error: err => { this.busy.set(null); this.error.set(this.githubErrorText(err)); },
    });
  }

  /** Reads the skill's origin again; when the repository moved on, the copy is replaced. */
  updateGitHub(s: InstalledSkill): void {
    if (this.busy()) return;
    this.busy.set(s.name);
    this.error.set('');
    this.notice.set('');
    this.api.updateGitHubSkill(s.name).subscribe({
      next: res => {
        this.busy.set(null);
        this.notice.set(this.translate.instant(res.updated ? 'herramientas.skills.github.updateDone' : 'herramientas.skills.github.updateNone', { name: s.name, commit: res.commit.slice(0, 7) }));
        const high = (res.findings ?? []).filter(f => f.severity === 'high');
        if (high.length) this.error.set(this.translate.instant('herramientas.skills.github.updateFindings', { name: s.name, n: high.length }));
        this.reload();
      },
      error: err => {
        this.busy.set(null);
        const code = err?.error?.error;
        const key = code === 'renamed' ? 'renamed' : code === 'not_installable' ? 'notInstallable' : null;
        this.error.set(key ? this.translate.instant('herramientas.skills.github.' + key, { name: s.name, detail: String(err?.error?.message ?? '') }) : this.githubErrorText(err, s.name));
      },
    });
  }

  /** The server's typed GitHub errors, said in the user's language. */
  private githubErrorText(err: any, name?: string): string {
    const code = String(err?.error?.error ?? '');
    const known = ['bad_url', 'not_found', 'no_skills', 'rate_limited', 'too_large', 'github_error'];
    return this.translate.instant('herramientas.skills.github.err.' + (known.includes(code) ? code : 'github_error'), { name: name ?? '' });
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

  /** A skill from the repository, in full: its files as they are there, the scan, the license, what it expects. */
  previewGitHub(s: GitHubSkillPreview): void {
    const r = this.repo();
    if (!r) return;
    this.preview.set({ title: s.name, version: s.version, author: s.author, loading: true, file: 'SKILL.md', action: { kind: 'github', path: s.path } });
    this.api.getGitHubSkill(this.skillUrl(s), r.commit).subscribe({
      next: detail => {
        const files = detail.files.some(f => f.path === 'SKILL.md') ? detail.files : [{ path: 'SKILL.md', content: detail.text }, ...detail.files];
        this.patchPreview({ loading: false, github: detail, data: { files, findings: detail.findings } });
      },
      error: err => this.patchPreview({ loading: false, error: this.githubErrorText(err) }),
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

  /** Whether the file shown is source code a skill ships: installed as text, never run. */
  currentIsCode(p: PreviewState): boolean {
    return !!p.github?.preview.files.find(f => f.path === p.file && f.status === 'code');
  }

  highFindings(p: PreviewState) { return (p.data?.findings ?? []).filter(f => f.severity === 'high'); }
  infoFindings(p: PreviewState) { return (p.data?.findings ?? []).filter(f => f.severity === 'info'); }

  findingText(code: string): string {
    return this.translate.instant('herramientas.skills.finding.' + code);
  }
}

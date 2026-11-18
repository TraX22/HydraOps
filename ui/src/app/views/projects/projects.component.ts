import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Subscription, catchError, EMPTY, interval, switchMap } from 'rxjs';
import { ApiService, Project, ProjectAcceptResult, ProjectChange, ProjectDetail } from '../../services/api.service';
import { AgentsService } from '../../services/agents.service';
import { ChatService } from '../../services/chat.service';
import { IconComponent } from '../../components/icon/icon.component';
import { ChatComponent } from '../chat/chat.component';

/** One line of the file tree as it is drawn: a folder (open or not) or a file. */
interface TreeRow {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  open?: boolean;
  /** A file the agent changed; for a folder, whether something inside it changed. */
  state?: ProjectChange['state'];
  changed?: boolean;
}

interface DiffLine { kind: 'add' | 'del' | 'hunk' | 'ctx'; text: string }

interface TreeNode { dirs: Map<string, TreeNode>; files: string[] }

const ACTIVE_KEY = 'hydra_project_active';

// Projects: one tab per project. Each tab shows the project's files as the agent sees
// them, the project's own chat with its agent, and what the agent changed, waiting for
// the user to accept (one commit on their branch) or discard. The agent works on a copy
// of each repository; nothing reaches the user's folder before they accept.
@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent, ChatComponent],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css',
})
export class ProjectsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private chat = inject(ChatService);
  private translate = inject(TranslateService);
  agents = inject(AgentsService);

  projects = signal<Project[]>([]);
  loaded = signal(false);
  /** The installed Git's version; null when Git is not installed. */
  git = signal<string | null>(null);
  activeId = signal<string | null>(this.stored());
  active = computed(() => this.projects().find(p => p.id === this.activeId()) ?? null);
  detail = signal<ProjectDetail | null>(null);

  // ── The tree ──
  files = signal<string[]>([]);
  treeTotal = signal(0);
  private openDirs = signal<ReadonlySet<string>>(new Set());
  private treeFor = '';

  // ── Changes ──
  selected = signal<string | null>(null);
  diff = signal<DiffLine[] | null>(null);
  diffCut = signal(false);
  diffNote = signal('');
  message = signal('');
  private messageTouched = false;
  working = signal<'' | 'accept' | 'discard'>('');
  results = signal<ProjectAcceptResult[]>([]);
  confirmDiscard = signal(false);

  // ── New project ──
  creating = signal(false);
  form = { name: '', folder: '', agentId: '', agentMemory: false };
  formError = signal('');
  saving = signal(false);

  // ── Settings, and the project's two files ──
  settingsOpen = signal(false);
  settings = { name: '', agentId: '', agentMemory: false };
  settingsError = signal('');
  confirmDelete = signal(false);
  fileOpen = signal<'' | 'instructions' | 'memory'>('');
  fileText = signal('');
  fileSaved = signal(false);
  initWorking = signal(false);
  initError = signal('');

  private poll?: Subscription;
  /** The chat that was open in the Chat view, given back on leaving. */
  private previousTab = 'main';
  private changesKey = '';

  ngOnInit(): void {
    const tab = this.chat.activeTab();
    this.previousTab = tab.startsWith('project:') ? 'main' : tab;
    this.load(true);
    this.poll = interval(4000).pipe(
      switchMap(() => { const id = this.activeId(); return id && this.active() ? this.api.getProject(id).pipe(catchError(() => EMPTY)) : EMPTY; }),
    ).subscribe(d => this.applyDetail(d));
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
    this.chat.stopPolling();
    this.chat.activeTab.set(this.previousTab);
  }

  private stored(): string | null {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  }

  private load(first = false): void {
    this.api.getProjects().subscribe({
      next: r => {
        this.projects.set(r.projects);
        this.git.set(r.git);
        this.loaded.set(true);
        if (first) {
          const keep = r.projects.find(p => p.id === this.activeId()) ?? r.projects[0];
          if (keep) this.open(keep);
          else this.activeId.set(null);
        }
      },
      error: () => this.loaded.set(true),
    });
  }

  agentOf(p: Project | null) {
    return p ? this.agents.agents().find(a => a.id === p.agentId) ?? null : null;
  }
  agentName(p: Project | null): string {
    return this.agentOf(p)?.name ?? p?.agentId ?? '';
  }

  open(p: Project): void {
    this.creating.set(false);
    this.settingsOpen.set(false);
    this.fileOpen.set('');
    this.activeId.set(p.id);
    try { localStorage.setItem(ACTIVE_KEY, p.id); } catch { /* storage unavailable */ }
    this.detail.set(null);
    this.files.set([]);
    this.selected.set(null);
    this.diff.set(null);
    this.results.set([]);
    this.message.set('');
    this.messageTouched = false;
    this.confirmDiscard.set(false);
    this.changesKey = '';
    const agent = this.agentOf(p);
    this.chat.setChannelAgent(p.channel, { id: p.agentId, label: agent?.name ?? p.agentId, avatarUrl: agent?.avatarUrl });
    this.chat.switchTab(p.channel);
    this.api.getProject(p.id).subscribe({ next: d => this.applyDetail(d), error: () => {} });
  }

  private applyDetail(d: ProjectDetail): void {
    if (d.project.id !== this.activeId()) return;
    this.detail.set(d);
    this.projects.update(list => list.map(p => (p.id === d.project.id ? d.project : p)));
    const key = d.changes.map(c => `${c.state}:${c.path}:${c.added}:${c.removed}`).join('|') + `#${d.repos.length}`;
    if (key === this.changesKey && this.treeFor === d.project.id) return;
    this.changesKey = key;
    this.loadTree(d);
    // What is shown follows what is pending: a file that is no longer changed closes.
    const sel = this.selected();
    if (sel && !d.changes.some(c => c.path === sel)) { this.selected.set(null); this.diff.set(null); }
    else if (sel) this.showDiff(sel);
    if (!d.changes.length) { this.confirmDiscard.set(false); if (!this.messageTouched) this.message.set(''); }
    else if (!this.messageTouched && !this.message()) this.message.set(this.suggestedMessage());
  }

  private loadTree(d: ProjectDetail): void {
    const id = d.project.id;
    this.api.getProjectTree(id).subscribe({
      next: t => {
        if (id !== this.activeId()) return;
        this.files.set(t.files);
        this.treeTotal.set(t.total);
        const open = new Set(this.treeFor === id ? this.openDirs() : t.roots);
        // The folders that hold a change are opened, so the change is in sight.
        for (const c of d.changes) {
          const segs = c.path.split('/');
          for (let i = 1; i < segs.length; i++) open.add(segs.slice(0, i).join('/'));
        }
        this.openDirs.set(open);
        this.treeFor = id;
      },
      error: () => {},
    });
  }

  /** The tree as rows: folders first, each level in order; a deleted file still shows, struck through. */
  rows = computed<TreeRow[]>(() => {
    const changes = new Map((this.detail()?.changes ?? []).map(c => [c.path, c.state]));
    const all = new Set(this.files());
    for (const [p, s] of changes) if (s === 'deleted') all.add(p);
    const root: TreeNode = { dirs: new Map(), files: [] };
    for (const p of all) {
      const segs = p.split('/');
      let at = root;
      for (const s of segs.slice(0, -1)) {
        if (!at.dirs.has(s)) at.dirs.set(s, { dirs: new Map(), files: [] });
        at = at.dirs.get(s)!;
      }
      at.files.push(segs[segs.length - 1]);
    }
    const changedDirs = new Set<string>();
    for (const p of changes.keys()) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) changedDirs.add(segs.slice(0, i).join('/'));
    }
    const open = this.openDirs();
    const out: TreeRow[] = [];
    const walk = (node: TreeNode, base: string, depth: number) => {
      for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const path = base ? `${base}/${name}` : name;
        const isOpen = open.has(path);
        out.push({ path, name, depth, dir: true, open: isOpen, changed: changedDirs.has(path) });
        if (isOpen) walk(node.dirs.get(name)!, path, depth + 1);
      }
      for (const name of node.files.sort((a, b) => a.localeCompare(b))) {
        const path = base ? `${base}/${name}` : name;
        out.push({ path, name, depth, dir: false, state: changes.get(path) });
      }
    };
    walk(root, '', 0);
    return out;
  });

  clickRow(row: TreeRow): void {
    if (row.dir) {
      const next = new Set(this.openDirs());
      if (next.has(row.path)) next.delete(row.path); else next.add(row.path);
      this.openDirs.set(next);
    } else if (row.state) {
      this.showDiff(row.path);
    }
  }

  // ── Changes ──
  totals = computed(() => {
    let added = 0, removed = 0;
    for (const c of this.detail()?.changes ?? []) { added += c.added ?? 0; removed += c.removed ?? 0; }
    return { added, removed };
  });

  showDiff(path: string): void {
    const id = this.activeId();
    if (!id) return;
    this.selected.set(path);
    this.api.getProjectDiff(id, path).subscribe({
      next: r => {
        if (this.selected() !== path) return;
        const lines: DiffLine[] = [];
        let started = false, binary = false;
        for (const l of r.diff.split('\n')) {
          if (/^Binary files /.test(l) || /^GIT binary patch/.test(l)) binary = true;
          if (l.startsWith('@@')) { started = true; lines.push({ kind: 'hunk', text: l }); continue; }
          if (!started || l.startsWith('\\ No newline')) continue;
          lines.push({ kind: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx', text: l.slice(1) });
        }
        while (lines.length && lines[lines.length - 1].kind === 'ctx' && !lines[lines.length - 1].text) lines.pop();
        this.diff.set(lines);
        this.diffCut.set(r.cut);
        this.diffNote.set(binary ? 'projects.changes.binary' : !lines.length ? 'projects.changes.emptyDiff' : '');
      },
      error: () => { this.diff.set([]); this.diffNote.set('projects.changes.diffFailed'); },
    });
  }

  closeDiff(): void {
    this.selected.set(null);
    this.diff.set(null);
  }

  onMessage(text: string): void {
    this.messageTouched = true;
    this.message.set(text);
  }

  /** A first line for the commit: what the user last asked for in this project's chat, cut short. */
  private suggestedMessage(): string {
    const p = this.active();
    const msgs = p ? this.chat.messagesByChannel()[p.channel] ?? [] : [];
    const last = [...msgs].reverse().find(m => m.role === 'user' && !m.planOf && !m.continuationOf && m.content?.trim());
    const line = (last?.content ?? '').replace(/\n*\[ATTACHMENTS\][\s\S]*$/, '').trim().split('\n')[0]?.trim() ?? '';
    return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
  }

  accept(): void {
    const id = this.activeId();
    if (!id || this.working()) return;
    this.working.set('accept');
    this.results.set([]);
    this.api.acceptProjectChanges(id, this.message().trim()).subscribe({
      next: r => {
        this.working.set('');
        this.results.set(r.results.filter(x => !x.ok || x.commit));
        if (r.results.every(x => x.ok)) { this.message.set(''); this.messageTouched = false; }
        this.refresh();
      },
      error: err => {
        this.working.set('');
        this.results.set([{ prefix: '', ok: false, reason: 'git', detail: err?.error?.error === 'agent_working' ? this.translate.instant('projects.changes.busy') : '' }]);
      },
    });
  }

  discard(paths?: string[]): void {
    const id = this.activeId();
    if (!id || this.working()) return;
    this.working.set('discard');
    this.results.set([]);
    this.api.discardProjectChanges(id, paths).subscribe({
      next: () => { this.working.set(''); this.confirmDiscard.set(false); this.refresh(); },
      error: () => { this.working.set(''); this.confirmDiscard.set(false); },
    });
  }

  private refresh(): void {
    const id = this.activeId();
    if (id) this.api.getProject(id).subscribe({ next: d => this.applyDetail(d), error: () => {} });
  }

  reasonText(r: ProjectAcceptResult): string {
    return this.translate.instant(`projects.changes.refused.${r.reason ?? 'git'}`);
  }

  // ── New project ──
  startCreating(): void {
    this.form = { name: '', folder: '', agentId: this.agents.agents()[0]?.id ?? '', agentMemory: false };
    this.formError.set('');
    this.creating.set(true);
  }

  /** The agent the form names: the one chosen, or the first of the list (what the closed select shows). */
  formAgent(): string {
    return this.form.agentId || this.agents.agents()[0]?.id || '';
  }

  cancelCreating(): void {
    this.creating.set(false);
  }

  create(): void {
    if (this.saving()) return;
    this.formError.set('');
    if (!this.form.name.trim()) { this.formError.set('projects.new.error.name_required'); return; }
    if (!this.form.folder.trim()) { this.formError.set('projects.new.error.not_absolute'); return; }
    const agentId = this.formAgent();
    if (!agentId) { this.formError.set('projects.new.error.agent_not_found'); return; }
    this.saving.set(true);
    this.api.createProject({ name: this.form.name, folder: this.form.folder.trim(), agentId, agentMemory: this.form.agentMemory }).subscribe({
      next: r => {
        this.saving.set(false);
        this.projects.update(list => [...list, r.project]);
        this.open(r.project);
      },
      error: err => {
        this.saving.set(false);
        const e = err?.error ?? {};
        const code = e.error === 'invalid_folder' ? e.reason : e.error;
        const key = `projects.new.error.${code}`;
        this.formError.set(this.translate.instant(key) === key ? 'projects.new.error.unknown' : key);
      },
    });
  }

  // ── Settings ──
  openSettings(): void {
    const p = this.active();
    if (!p) return;
    this.settings = { name: p.name, agentId: p.agentId, agentMemory: p.agentMemory };
    this.settingsError.set('');
    this.confirmDelete.set(false);
    this.fileOpen.set('');
    this.settingsOpen.set(true);
  }

  saveSettings(): void {
    const p = this.active();
    if (!p) return;
    this.api.updateProject(p.id, { name: this.settings.name, agentId: this.settings.agentId, agentMemory: this.settings.agentMemory }).subscribe({
      next: r => {
        this.settingsOpen.set(false);
        this.projects.update(list => list.map(x => (x.id === p.id ? r.project : x)));
        const agent = this.agentOf(r.project);
        this.chat.setChannelAgent(r.project.channel, { id: r.project.agentId, label: agent?.name ?? r.project.agentId, avatarUrl: agent?.avatarUrl });
        this.refresh();
      },
      error: err => this.settingsError.set(`projects.new.error.${err?.error?.error === 'name_required' ? 'name_required' : err?.error?.error === 'agent_not_found' ? 'agent_not_found' : 'unknown'}`),
    });
  }

  remove(): void {
    const p = this.active();
    if (!p) return;
    const pending = (this.detail()?.changes.length ?? 0) > 0;
    this.api.deleteProject(p.id, pending).subscribe({
      next: () => {
        this.settingsOpen.set(false);
        const rest = this.projects().filter(x => x.id !== p.id);
        this.projects.set(rest);
        this.detail.set(null);
        if (rest[0]) this.open(rest[0]);
        else { this.activeId.set(null); try { localStorage.removeItem(ACTIVE_KEY); } catch { /* storage unavailable */ } }
      },
      error: err => this.settingsError.set(err?.error?.error === 'agent_working' ? 'projects.changes.busy' : 'projects.new.error.unknown'),
    });
  }

  // ── The project's two files ──
  openFile(which: 'instructions' | 'memory'): void {
    const p = this.active();
    if (!p) return;
    this.settingsOpen.set(false);
    this.fileSaved.set(false);
    this.fileText.set('');
    this.fileOpen.set(which);
    const got = which === 'instructions' ? this.api.getProjectInstructions(p.id) : this.api.getProjectMemory(p.id);
    got.subscribe({ next: r => { if (this.fileOpen() === which) this.fileText.set(r.text); }, error: () => {} });
  }

  saveInstructions(): void {
    const p = this.active();
    if (!p) return;
    this.api.saveProjectInstructions(p.id, this.fileText()).subscribe({
      next: () => { this.fileSaved.set(true); this.refresh(); setTimeout(() => this.fileSaved.set(false), 2500); },
      error: () => {},
    });
  }

  acceptInstructions(): void {
    const p = this.active();
    if (!p) return;
    this.api.acceptProjectInstructions(p.id).subscribe({ next: () => this.refresh(), error: () => {} });
  }

  /** A folder that is not a repository yet (or has no commit): make it one from here. */
  initRepository(commitAll: boolean): void {
    const p = this.active();
    if (!p || this.initWorking()) return;
    this.initWorking.set(true);
    this.initError.set('');
    this.api.initProjectRepository(p.id, commitAll).subscribe({
      next: () => { this.initWorking.set(false); this.changesKey = ''; this.treeFor = ''; this.refresh(); },
      error: err => { this.initWorking.set(false); this.initError.set(err?.error?.error === 'identity' ? 'projects.changes.refused.identity' : 'projects.problem.initFailed'); },
    });
  }

  problemKey(code: string): string {
    return `projects.problem.${code}`;
  }
  /** Whether "make it a repository" answers this problem. */
  canInit(code: string, prefix: string): boolean {
    return !prefix && (code === 'no_repository' || code === 'no_commits');
  }

  stateLetter(state?: ProjectChange['state']): string {
    return state === 'added' ? 'A' : state === 'deleted' ? 'D' : state === 'modified' ? 'M' : '';
  }
}

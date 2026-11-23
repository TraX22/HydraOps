import { Component, OnDestroy, OnInit, computed, inject, signal, viewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Subscription, catchError, EMPTY, interval, switchMap } from 'rxjs';
import { ApiService, Project, ProjectAcceptResult, ProjectChange, ProjectDetail } from '../../services/api.service';
import { AgentsService } from '../../services/agents.service';
import { ChatService } from '../../services/chat.service';
import { IconComponent } from '../../components/icon/icon.component';
import { ChatComponent } from '../chat/chat.component';
import { CodeEditorComponent } from '../../components/code-editor/code-editor.component';
import { OpenFile, ProjectFilesService } from '../../services/project-files.service';
import { ThemeService } from '../../services/theme.service';

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
  imports: [FormsModule, TranslatePipe, IconComponent, ChatComponent, CodeEditorComponent],
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
  settings = { name: '', agentId: '', agentMemory: false, secrets: [] as string[] };
  settingsError = signal('');
  confirmDelete = signal(false);
  /** The folder of a deleted project's copy that could not be removed (a program has it open). */
  deleteLeftover = signal<string | null>(null);
  fileOpen = signal<'' | 'instructions' | 'memory'>('');
  fileText = signal('');
  fileSaved = signal(false);
  initWorking = signal(false);
  initError = signal('');

  // ── The editor: the files opened from the tree, each in its own tab of the right panel ──
  private filesStore = inject(ProjectFilesService);
  theme = inject(ThemeService);
  openFiles = signal<OpenFile[]>([]);
  /** 'changes', or the path of the open file in front. */
  rightTab = signal<string>('changes');
  /** The file whose tab the user asked to close while it has unsaved edits. */
  closing = signal<string | null>(null);
  copied = signal<string | null>(null);
  dirtyCount = computed(() => this.openFiles().filter(f => f.dirty).length);
  private editors = viewChildren(CodeEditorComponent);
  private wasBusy = false;
  /** The project whose open files `openFiles` holds. */
  private filesShownFor: string | null = null;

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
    this.keepOpenFiles();
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
    this.keepOpenFiles();
    const kept = this.filesStore.load(p.id);
    // A file that was still being read when the view went away is simply not open.
    const files = kept.files.filter(f => !f.loading);
    this.openFiles.set(files);
    this.rightTab.set(kept.tab === 'changes' || files.some(f => f.path === kept.tab) ? kept.tab : 'changes');
    this.filesShownFor = p.id;
    this.closing.set(null);
    this.wasBusy = false;
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
    // The commit's message offered is the agent's own line for its change, and follows it while
    // the agent keeps working; once the user writes in the box, the box is theirs.
    if (!this.messageTouched && d.changes.length) this.message.set(d.suggestedMessage ?? '');
    const key = d.changes.map(c => `${c.state}:${c.path}:${c.added}:${c.removed}`).join('|') + `#${d.repos.length}`;
    // The agent just finished, or what is pending changed: the open files are read again.
    const finished = this.wasBusy && !d.busy;
    this.wasBusy = d.busy;
    if (finished || (key !== this.changesKey && this.changesKey !== '')) this.syncOpenFiles();
    if (key === this.changesKey && this.treeFor === d.project.id) return;
    this.changesKey = key;
    this.loadTree(d);
    // What is shown follows what is pending: a file that is no longer changed closes.
    const sel = this.selected();
    if (sel && !d.changes.some(c => c.path === sel)) { this.selected.set(null); this.diff.set(null); }
    else if (sel) this.showDiff(sel);
    if (!d.changes.length) { this.confirmDiscard.set(false); if (!this.messageTouched) this.message.set(''); }
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
    } else if (row.state === 'deleted') {
      // Nothing to open: what is left of it is its diff.
      this.rightTab.set('changes');
      this.showDiff(row.path);
    } else {
      this.openInEditor(row.path);
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
    if (this.serverLogOf()) this.loadServerLog();
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

  // ── Servers: the project's programs that are kept running ──
  /** The servers worth showing: the ones running, and the last one that ended (to read why). */
  servers = computed(() => {
    const all = this.detail()?.servers ?? [];
    const running = all.filter(s => s.status === 'running');
    const ended = all.filter(s => s.status !== 'running').sort((a, b) => (b.stoppedAt ?? '').localeCompare(a.stoppedAt ?? '')).slice(0, running.length ? 0 : 1);
    return [...running, ...ended];
  });
  /** The server whose output is open, and that output. */
  serverLogOf = signal<string | null>(null);
  serverLogText = signal('');
  stoppingServer = signal<string | null>(null);

  toggleServerLog(name: string): void {
    if (this.serverLogOf() === name) { this.serverLogOf.set(null); return; }
    this.serverLogOf.set(name);
    this.serverLogText.set('');
    this.loadServerLog();
  }

  private loadServerLog(): void {
    const p = this.active(); const name = this.serverLogOf();
    if (!p || !name) return;
    this.api.projectServerLog(p.id, name, 60).subscribe({
      next: r => { if (this.serverLogOf() === name) this.serverLogText.set(r.text); },
      error: () => { if (this.serverLogOf() === name) this.serverLogText.set(''); },
    });
  }

  stopServer(name: string): void {
    const p = this.active();
    if (!p || this.stoppingServer()) return;
    this.stoppingServer.set(name);
    this.api.stopProjectServer(p.id, name).subscribe({
      next: () => { this.stoppingServer.set(null); this.refresh(); },
      error: () => { this.stoppingServer.set(null); this.refresh(); },
    });
  }

  toggleSecret(file: string, on: boolean): void {
    const set = new Set(this.settings.secrets);
    if (on) set.add(file); else set.delete(file);
    this.settings.secrets = [...set];
  }

  // ── Settings ──
  openSettings(): void {
    const p = this.active();
    if (!p) return;
    this.settings = { name: p.name, agentId: p.agentId, agentMemory: p.agentMemory, secrets: [...(this.detail()?.secrets?.chosen ?? [])] };
    this.settingsError.set('');
    this.confirmDelete.set(false);
    this.fileOpen.set('');
    this.settingsOpen.set(true);
  }

  saveSettings(): void {
    const p = this.active();
    if (!p) return;
    this.api.updateProject(p.id, { name: this.settings.name, agentId: this.settings.agentId, agentMemory: this.settings.agentMemory, serverSecrets: this.settings.secrets }).subscribe({
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
      next: r => {
        this.settingsOpen.set(false);
        this.deleteLeftover.set(r?.leftover || null);
        const rest = this.projects().filter(x => x.id !== p.id);
        this.projects.set(rest);
        this.detail.set(null);
        this.filesStore.forget(p.id);
        this.openFiles.set([]);
        this.rightTab.set('changes');
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
      error: err => { this.initWorking.set(false); this.initError.set(err?.error?.error === 'identity' ? 'projects.changes.refused.identity' : err?.error?.error === 'read_only' ? 'projects.problem.read_only' : 'projects.problem.initFailed'); },
    });
  }

  /** Whether one of the project's own files is already in the repository's history (ignoring it does not stop Git following it). */
  isTracked(file: string): boolean {
    return (this.detail()?.repos ?? []).some(r => (r.tracked ?? []).includes(file));
  }

  problemKey(code: string): string {
    return `projects.problem.${code}`;
  }
  /** Whether "make it a repository" answers this problem. */
  canInit(code: string, prefix: string): boolean {
    return !prefix && (code === 'no_repository' || code === 'no_commits');
  }

  // ── The editor ──
  fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  private patchFile(path: string, patch: Partial<OpenFile>): void {
    this.openFiles.update(list => list.map(f => (f.path === path ? { ...f, ...patch } : f)));
  }

  private editorOf(path: string): CodeEditorComponent | undefined {
    return this.editors().find(e => e.path() === path);
  }

  /** Before the view (or this project's tab) goes away: what was typed and not saved is kept. */
  private keepOpenFiles(): void {
    const id = this.activeId();
    // Only what this view is showing is kept: before the first project opens there is nothing of its own to keep.
    if (!id || this.filesShownFor !== id) return;
    const files = this.openFiles().map(f => (f.dirty ? { ...f, draft: this.editorOf(f.path)?.value() ?? f.draft ?? f.text } : { ...f, draft: undefined }));
    this.filesStore.store(id, files, this.rightTab());
  }

  /** A file of the tree opens in a tab of the right panel (or comes to the front if it is open). */
  openInEditor(path: string): void {
    const id = this.activeId();
    if (!id) return;
    this.settingsOpen.set(false);
    this.fileOpen.set('');
    this.rightTab.set(path);
    if (this.openFiles().some(f => f.path === path)) return;
    this.openFiles.update(list => [...list, { path, text: '', hash: '', state: null, changedLines: [], source: '', loading: true, dirty: false, stale: false, saving: false }]);
    this.api.getProjectFile(id, path).subscribe({
      next: f => this.patchFile(path, { text: f.text, hash: f.hash, state: f.state, changedLines: f.changedLines, source: f.source, loading: false }),
      error: err => this.patchFile(path, { loading: false, error: this.fileProblem(err) }),
    });
  }

  private fileProblem(err: any): string {
    const code = String(err?.error?.error ?? '');
    return ['not_found', 'is_folder', 'too_large', 'binary', 'credentials', 'invalid_path'].includes(code) ? code : 'unknown';
  }

  markDirty(path: string): void {
    const f = this.openFiles().find(x => x.path === path);
    if (f && !f.dirty) this.patchFile(path, { dirty: true, saveError: undefined });
  }

  saveFile(path: string): void {
    const id = this.activeId();
    const f = this.openFiles().find(x => x.path === path);
    const editor = this.editorOf(path);
    if (!id || !f || !editor || !f.dirty || f.saving || this.detail()?.busy) return;
    const content = editor.value();
    this.patchFile(path, { saving: true, saveError: undefined });
    this.api.saveProjectFile(id, path, content, f.hash).subscribe({
      next: r => {
        this.patchFile(path, { saving: false, dirty: false, stale: false, draft: undefined, text: content, hash: r.hash });
        this.closing.set(null);
        this.refresh();
        this.refreshMarks(path);
      },
      error: err => {
        const code = err?.error?.error;
        this.patchFile(path, { saving: false, stale: code === 'changed' ? true : f.stale, saveError: code === 'changed' ? undefined : code === 'agent_working' ? 'projects.editor.readOnly' : 'projects.editor.saveFailed' });
      },
    });
  }

  /** After a save: the file's state and its changed lines, as the copy has them now. */
  private refreshMarks(path: string): void {
    const id = this.activeId();
    if (!id) return;
    this.api.getProjectFile(id, path).subscribe({
      next: f => { const cur = this.openFiles().find(x => x.path === path); if (cur && !cur.dirty && cur.hash === f.hash) this.patchFile(path, { state: f.state, changedLines: f.changedLines }); },
      error: () => {},
    });
  }

  /** Read the file again from the copy, dropping what was typed here. */
  reloadFile(path: string): void {
    const id = this.activeId();
    if (!id) return;
    this.api.getProjectFile(id, path).subscribe({
      next: f => {
        this.patchFile(path, { text: f.text, hash: f.hash, state: f.state, changedLines: f.changedLines, source: f.source, dirty: false, stale: false, draft: undefined, error: undefined, saveError: undefined });
        this.editorOf(path)?.setText(f.text, f.changedLines);
      },
      error: err => this.afterFileGone(path, err),
    });
  }

  private afterFileGone(path: string, err: any): void {
    if (err?.status !== 404) return;
    // The file is no longer in the copy (a discarded new file): its tab closes.
    this.openFiles.update(list => list.filter(f => f.path !== path));
    if (this.rightTab() === path) this.rightTab.set('changes');
  }

  /**
   * The copy changed (the agent worked, or changes were accepted or discarded): each open
   * file is read again. One with nothing unsaved takes the new text; one with unsaved
   * edits keeps them and says the file changed underneath.
   */
  private syncOpenFiles(): void {
    const id = this.activeId();
    if (!id) return;
    for (const open of this.openFiles()) {
      if (open.loading || open.error) continue;
      const path = open.path;
      this.api.getProjectFile(id, path).subscribe({
        next: f => {
          const cur = this.openFiles().find(x => x.path === path);
          if (!cur || this.activeId() !== id) return;
          if (f.hash === cur.hash) { this.patchFile(path, cur.dirty ? { state: f.state } : { state: f.state, changedLines: f.changedLines }); return; }
          if (cur.dirty) { this.patchFile(path, { stale: true }); return; }
          this.patchFile(path, { text: f.text, hash: f.hash, state: f.state, changedLines: f.changedLines });
          this.editorOf(path)?.setText(f.text, f.changedLines);
        },
        error: err => this.afterFileGone(path, err),
      });
    }
  }

  closeFile(path: string, ev: Event, force = false): void {
    ev.stopPropagation();
    const f = this.openFiles().find(x => x.path === path);
    if (f?.dirty && !force) { this.rightTab.set(path); this.closing.set(path); return; }
    this.closing.set(null);
    this.openFiles.update(list => list.filter(x => x.path !== path));
    if (this.rightTab() === path) this.rightTab.set('changes');
  }

  showDiffOf(path: string): void {
    this.rightTab.set('changes');
    this.showDiff(path);
  }

  /** The desktop app can show a file in the system's file manager; a browser cannot. */
  private readonly reveal = (window as unknown as { hydraDesktop?: { revealInFolder?: (target: string) => Promise<boolean> } }).hydraDesktop?.revealInFolder;
  readonly canReveal = typeof this.reveal === 'function';
  /** The file whose folder could not be shown, for a moment. */
  revealFailed = signal<string | null>(null);

  /** Shows the file in the user's own folder (their version, not the pending changes). */
  showInFolder(f: OpenFile): void {
    if (!this.reveal || !f.source) return;
    this.reveal(f.source).then(ok => {
      if (ok) return;
      this.revealFailed.set(f.path);
      setTimeout(() => this.revealFailed.set(null), 2500);
    }).catch(() => {});
  }

  /** The file's place in the user's own folder, to open it in their editor. */
  copyPath(f: OpenFile): void {
    navigator.clipboard.writeText(f.source).then(() => {
      this.copied.set(f.path);
      setTimeout(() => this.copied.set(null), 2000);
    }).catch(() => {});
  }

  stateLetter(state?: ProjectChange['state']): string {
    return state === 'added' ? 'A' : state === 'deleted' ? 'D' : state === 'modified' ? 'M' : '';
  }
}

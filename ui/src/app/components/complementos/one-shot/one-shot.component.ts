import { Component, inject, signal, computed, OnInit, viewChild, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  FFlowModule,
  FCreateConnectionEvent,
  FReassignConnectionEvent,
  FSelectionChangeEvent,
  FCanvasComponent,
  FZoomDirective,
} from '@foblex/flow';
import { IconComponent } from '../../icon/icon.component';
import { ApiService, Agent, PromptGraph } from '../../../services/api.service';
import { ChatService } from '../../../services/chat.service';
import { ComplementosService } from '../../../services/complementos.service';

// A node the user drew: an editable title plus free-text body describing a
// piece/step of the task, plus its canvas position (a two-way Foblex model, so
// drags persist). Icon and header colour are cosmetic, chosen by the user;
// undefined means the defaults (table icon, theme-grey header).
interface FlowNode {
  id: string;
  title: string;
  text: string;
  position: { x: number; y: number };
  icon?: string;
  color?: string;
}

interface FlowConn {
  id: string;
  source: string;
  target: string;
}

// A named, saved diagram in the right-panel history. The active one mirrors the
// live canvas; others are snapshots the user can reopen and rename freely.
interface SavedDiagram {
  id: string;
  name: string;
  nodes: FlowNode[];
  connections: FlowConn[];
  updatedAt: number;
}

// One Shot: draw the task as a flow diagram (generic nodes + directed
// connections) and compile it, via the configured LLM, into a single
// self-contained "one-shot" prompt. Classic Foblex mode — this component owns
// the graph state; user gestures emit events that we fold back into signals.
@Component({
  selector: 'app-one-shot',
  standalone: true,
  imports: [FormsModule, FFlowModule, TranslatePipe, IconComponent],
  templateUrl: './one-shot.component.html',
  styleUrl: './one-shot.component.css',
})
export class OneShotComponent implements OnInit {
  private api = inject(ApiService);
  private chat = inject(ChatService);
  private complementos = inject(ComplementosService);
  private router = inject(Router);
  private i18n = inject(TranslateService);

  readonly nodes = signal<FlowNode[]>([]);
  readonly connections = signal<FlowConn[]>([]);
  // Ids of connections the user has currently selected on the canvas (for delete).
  readonly selectedConns = signal<string[]>([]);
  // Ids of the selected nodes — the palette paints these.
  readonly selectedNodes = signal<string[]>([]);
  // Last node the user touched. Foblex selection misses clicks landing on the
  // node's inputs (fDragBlocker swallows them), so any pointerdown on a node
  // marks it active — that's what the palette paints when nothing is selected.
  readonly activeNode = signal<string>('');
  // Node id whose icon picker popover is open ('' = none).
  readonly iconPickerFor = signal<string>('');
  // Palette colour applied to nodes created from now on (when nothing is selected).
  readonly defaultColor = signal<string>('');

  // Icons the user can pick for a node (all already in IconComponent).
  readonly nodeIcons = [
    'table', 'file', 'chat', 'mail', 'send', 'clipboard',
    'image', 'video', 'code', 'github', 'zap', 'puzzle',
    'memory', 'storage', 'monitor', 'bell',
  ];
  // Two palette rows of 12: vivid on top, their pastel versions below.
  readonly vividColors = [
    '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
    '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#78716c',
  ];
  readonly pastelColors = [
    '#fca5a5', '#fdba74', '#fcd34d', '#bef264', '#86efac', '#5eead4',
    '#67e8f9', '#93c5fd', '#a5b4fc', '#d8b4fe', '#f9a8d4', '#d6d3d1',
  ];
  readonly agents = signal<Agent[]>([]);
  readonly selectedAgent = signal<string>('');

  // Saved-diagram history shown in the right panel; activeId is the one loaded
  // on the canvas.
  readonly diagrams = signal<SavedDiagram[]>([]);
  readonly activeId = signal<string>('');
  // History shown most-recently-edited first (the stored order is untouched).
  // On an updatedAt tie — e.g. a brand-new diagram created in the same
  // millisecond the previous one was flushed — the active diagram floats up.
  readonly orderedDiagrams = computed(() => {
    const active = this.activeId();
    return [...this.diagrams()].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.id === active ? -1 : b.id === active ? 1 : 0),
    );
  });
  // Id of the diagram whose delete is awaiting inline confirmation ('' = none).
  readonly pendingDelete = signal<string>('');

  readonly compiling = signal(false);
  readonly compiledPrompt = signal('');
  readonly error = signal('');
  readonly copied = signal(false);

  private counter = 0;

  // The whole history autosaves here (list of named diagrams + active id + agent),
  // so closing the modal, backing out to the hub, or reloading never loses work.
  private static readonly STORE_KEY = 'hydra_oneshot_store_v1';
  // Legacy single-graph key, migrated into the history on first load.
  private static readonly OLD_KEY = 'hydra_oneshot_graph_v1';

  // Foblex viewport controls: zoom lives on the fZoom directive, fit on the canvas.
  private readonly canvas = viewChild(FCanvasComponent);
  private readonly zoom = viewChild(FZoomDirective);

  zoomIn(): void { this.zoom()?.zoomIn(); }
  zoomOut(): void { this.zoom()?.zoomOut(); }
  fit(): void { this.canvas()?.fitToScreen(); }

  ngOnInit(): void {
    this.restore();
    this.api.getAgents().subscribe({
      next: (list) => {
        this.agents.set(list);
        // Keep a restored agent if it still exists; otherwise fall back to the first.
        const current = this.selectedAgent();
        if (!current || !list.some((a) => a.id === current)) {
          if (list.length) this.selectedAgent.set(list[0].id);
        }
      },
      error: () => {},
    });
  }

  // Fold the live canvas into the active diagram, then persist the whole store.
  // Called on every mutation; localStorage may throw (private mode) — ignore.
  save(): void {
    const id = this.activeId();
    if (id) {
      this.diagrams.update((list) =>
        list.map((d) =>
          d.id === id ? { ...d, nodes: this.nodes(), connections: this.connections(), updatedAt: Date.now() } : d,
        ),
      );
    }
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        OneShotComponent.STORE_KEY,
        JSON.stringify({ activeId: this.activeId(), selectedAgent: this.selectedAgent(), defaultColor: this.defaultColor(), diagrams: this.diagrams() }),
      );
    } catch {
      /* storage unavailable or full — nothing we can do */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(OneShotComponent.STORE_KEY);
      if (raw) {
        const store = JSON.parse(raw);
        const list: SavedDiagram[] = Array.isArray(store?.diagrams) ? store.diagrams : [];
        this.diagrams.set(list);
        if (typeof store?.selectedAgent === 'string') this.selectedAgent.set(store.selectedAgent);
        if (typeof store?.defaultColor === 'string') this.defaultColor.set(store.defaultColor);
        const active = list.find((d) => d.id === store?.activeId) ?? list[0];
        if (active) return this.setActive(active, false);
        return this.ensureActive();
      }
      // Migrate the legacy single-graph key into one named diagram.
      const old = localStorage.getItem(OneShotComponent.OLD_KEY);
      if (old) {
        const data = JSON.parse(old);
        const d: SavedDiagram = {
          id: this.uid(),
          name: this.nextName(),
          nodes: Array.isArray(data?.nodes) ? data.nodes : [],
          connections: Array.isArray(data?.connections) ? data.connections : [],
          updatedAt: Date.now(),
        };
        this.diagrams.set([d]);
        if (typeof data?.selectedAgent === 'string') this.selectedAgent.set(data.selectedAgent);
        this.setActive(d, false);
        localStorage.removeItem(OneShotComponent.OLD_KEY);
        this.persist();
        return;
      }
      this.ensureActive();
    } catch {
      /* corrupt or blocked storage — start with a fresh diagram */
      this.ensureActive();
    }
  }

  // Load a saved diagram onto the canvas (copying its arrays so later edits don't
  // silently alias the stored snapshot).
  private setActive(d: SavedDiagram, persist: boolean): void {
    this.activeId.set(d.id);
    this.nodes.set([...(d.nodes ?? [])]);
    this.connections.set([...(d.connections ?? [])]);
    this.compiledPrompt.set('');
    this.error.set('');
    this.selectedNodes.set([]);
    this.activeNode.set('');
    this.iconPickerFor.set('');
    let max = -1;
    for (const n of this.nodes()) {
      const m = /^n(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    this.counter = max + 1;
    if (persist) this.persist();
  }

  // Guarantee there is always one active diagram, so the very first nodes a user
  // draws land in the history.
  private ensureActive(): void {
    if (this.activeId() && this.diagrams().some((d) => d.id === this.activeId())) return;
    const list = this.diagrams();
    if (list.length) {
      this.setActive(list[0], true);
      return;
    }
    const d: SavedDiagram = { id: this.uid(), name: this.nextName(), nodes: [], connections: [], updatedAt: Date.now() };
    this.diagrams.set([d]);
    this.setActive(d, true);
  }

  private uid(): string {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Default name like "Diagrama 3": the diagram word (localized) + next free index.
  private nextName(): string {
    const base = this.i18n.instant('oneShot.diagram') || 'Diagram';
    return `${base} ${this.diagrams().length + 1}`;
  }

  // ---- History actions (right panel) ----
  newDiagram(): void {
    this.pendingDelete.set('');
    this.save(); // flush the current one first
    const d: SavedDiagram = { id: this.uid(), name: this.nextName(), nodes: [], connections: [], updatedAt: Date.now() };
    this.diagrams.update((list) => [...list, d]);
    this.setActive(d, true);
  }

  loadDiagram(id: string): void {
    if (id === this.activeId()) return;
    this.pendingDelete.set('');
    this.save(); // flush current before switching
    const d = this.diagrams().find((x) => x.id === id);
    if (d) this.setActive(d, true);
  }

  renameDiagram(id: string, name: string): void {
    this.diagrams.update((list) => list.map((d) => (d.id === id ? { ...d, name } : d)));
    this.persist();
  }

  // Deleting a diagram is destructive, so the trash button first arms an inline
  // confirm (a check/cancel pair replaces it) before deleteDiagram actually runs.
  askDeleteDiagram(id: string): void {
    this.pendingDelete.set(id);
  }

  cancelDeleteDiagram(): void {
    this.pendingDelete.set('');
  }

  deleteDiagram(id: string): void {
    this.pendingDelete.set('');
    const list = this.diagrams().filter((d) => d.id !== id);
    this.diagrams.set(list);
    if (this.activeId() === id) {
      this.activeId.set('');
      this.ensureActive(); // load another, or spin up a fresh empty one
    }
    this.persist();
  }

  addNode(): void {
    const i = this.counter++;
    // Stagger new nodes so they don't stack on the exact same spot.
    this.nodes.update((a) => [
      ...a,
      {
        id: `n${i}`, title: '', text: '',
        position: { x: 80 + (i % 4) * 230, y: 70 + Math.floor(i / 4) * 170 },
        color: this.defaultColor() || undefined,
      },
    ]);
    this.save();
  }

  // ---- Node appearance (icon + header colour) ----
  toggleIconPicker(id: string, ev: Event): void {
    ev.stopPropagation();
    this.iconPickerFor.set(this.iconPickerFor() === id ? '' : id);
  }

  setNodeIcon(id: string, icon: string, ev: Event): void {
    ev.stopPropagation();
    this.nodes.update((a) => a.map((n) => (n.id === id ? { ...n, icon } : n)));
    this.iconPickerFor.set('');
    this.save();
  }

  // Any click outside the picker closes it (the trigger stops propagation).
  @HostListener('document:click')
  closeIconPicker(): void {
    if (this.iconPickerFor()) this.iconPickerFor.set('');
  }

  // Nodes the palette would paint right now: the Foblex selection or, failing
  // that, the last node touched.
  private paintTargets(): string[] {
    const sel = this.selectedNodes();
    if (sel.length) return sel;
    const active = this.activeNode();
    return active && this.nodes().some((n) => n.id === active) ? [active] : [];
  }

  markActive(id: string): void {
    this.activeNode.set(id);
  }

  // Pointerdown on empty canvas (not on a node) drops the active mark, so the
  // next colour pick goes back to setting the default for new nodes.
  onCanvasPointerDown(ev: Event): void {
    const el = ev.target as HTMLElement | null;
    if (el && !el.closest('.os-node')) this.activeNode.set('');
  }

  // Swatch highlight: the colour all target nodes share or, with no target,
  // the default for new nodes.
  isActiveColor(color: string): boolean {
    const targets = this.paintTargets();
    if (!targets.length) return this.defaultColor() === color;
    const nodes = this.nodes().filter((n) => targets.includes(n.id));
    return nodes.length > 0 && nodes.every((n) => n.color === color);
  }

  // Paint the target node(s) with a palette colour; clicking the colour they
  // all already have clears it back to the default header. With no target,
  // the pick becomes the colour for nodes created from now on.
  applyColor(color: string): void {
    const targets = this.paintTargets();
    if (!targets.length) {
      this.defaultColor.set(this.defaultColor() === color ? '' : color);
      this.persist();
      return;
    }
    const nodes = this.nodes().filter((n) => targets.includes(n.id));
    const clearing = nodes.length > 0 && nodes.every((n) => n.color === color);
    this.nodes.update((a) =>
      a.map((n) => (targets.includes(n.id) ? { ...n, color: clearing ? undefined : color } : n)),
    );
    this.save();
  }

  // Readable text/icon colour over a custom header: dark on light backgrounds
  // (all the pastels), white on the vivid ones. Perceived-luminance cut.
  headText(color?: string): string | null {
    if (!color) return null;
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return null;
    const v = parseInt(m[1], 16);
    const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
    return lum > 150 ? '#1f2937' : '#ffffff';
  }

  // Each node exposes one connector per side; connector ids are `${nodeId}:${side}`
  // (t/r/b/l), so `nodeOf` maps an endpoint back to its node.
  private nodeOf(connectorId: string): string {
    return connectorId.split(':')[0];
  }

  removeNode(id: string): void {
    if (this.activeNode() === id) this.activeNode.set('');
    if (this.iconPickerFor() === id) this.iconPickerFor.set('');
    this.nodes.update((a) => a.filter((n) => n.id !== id));
    this.connections.update((a) => a.filter((c) => this.nodeOf(c.source) !== id && this.nodeOf(c.target) !== id));
    this.save();
  }

  // A connection was drawn between two side-connectors. We keep the exact
  // connector ids (source/target sides) but reject self-links and duplicates.
  // The line's endpoints resolve dynamically (fSourceSide/fTargetSide="calculate").
  onConnect(e: FCreateConnectionEvent): void {
    const source = e.sourceId;
    const target = e.targetId;
    if (!source || !target || this.nodeOf(source) === this.nodeOf(target)) return;
    if (this.connections().some((c) => c.source === source && c.target === target)) return;
    this.connections.update((a) => [...a, { id: `c-${source}-${target}`, source, target }]);
    this.save();
  }

  // The user dragged one endpoint of an existing connection to re-route it.
  // Rebuild that edge with its new source/target (dropping self-links and
  // duplicates); dropping onto nothing disconnects it.
  onReassign(e: FReassignConnectionEvent): void {
    const source = e.endpoint === 'source' ? e.nextSourceId : e.previousSourceId;
    const target = e.endpoint === 'target' ? e.nextTargetId : e.previousTargetId;
    if (!source || !target) {
      // Dropped in empty space → remove the connection.
      this.connections.update((a) => a.filter((c) => c.id !== e.connectionId));
      this.save();
      return;
    }
    // Self-link is invalid: leave the model untouched so it reverts on re-render.
    if (this.nodeOf(source) === this.nodeOf(target)) return;
    this.connections.update((list) => {
      const others = list.filter((c) => c.id !== e.connectionId);
      // Merge onto an existing identical edge instead of duplicating it.
      if (others.some((c) => c.source === source && c.target === target)) return others;
      return [...others, { id: `c-${source}-${target}`, source, target }];
    });
    this.save();
  }

  // Track which connections are selected (for delete) and which nodes are
  // selected (the colour palette paints them).
  onSelectionChange(e: FSelectionChangeEvent): void {
    this.selectedConns.set(e.connectionIds ?? []);
    this.selectedNodes.set(e.nodeIds ?? []);
  }

  deleteSelectedConns(): void {
    const sel = this.selectedConns();
    if (!sel.length) return;
    this.connections.update((a) => a.filter((c) => !sel.includes(c.id)));
    this.selectedConns.set([]);
    this.save();
  }

  // Delete/Backspace removes the selected connection(s) — but never while the
  // user is typing in a node's title/body (that would eat their text).
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!this.selectedConns().length) return;
    e.preventDefault();
    this.deleteSelectedConns();
  }

  clear(): void {
    this.nodes.set([]);
    this.connections.set([]);
    this.selectedConns.set([]);
    this.selectedNodes.set([]);
    this.activeNode.set('');
    this.iconPickerFor.set('');
    this.compiledPrompt.set('');
    this.error.set('');
    this.counter = 0;
    this.save();
  }

  back(): void {
    this.complementos.openHub();
  }

  // A node counts as filled if it has a title or body. Its serialized text is
  // "Title: body", "Title", or the body alone — whatever the user provided.
  private nodeLabel(n: FlowNode): string {
    const title = n.title.trim();
    const body = n.text.trim();
    if (title && body) return `${title}: ${body}`;
    return title || body;
  }

  compile(): void {
    const filled = this.nodes().filter((n) => this.nodeLabel(n));
    if (!filled.length) return;
    this.compiling.set(true);
    this.error.set('');
    this.compiledPrompt.set('');

    // Connection endpoints carry a `:side` suffix; map to node ids, dedupe, and
    // keep only edges between filled nodes.
    const filledIds = new Set(filled.map((n) => n.id));
    const seen = new Set<string>();
    const edges: { source: string; target: string }[] = [];
    for (const c of this.connections()) {
      const s = this.nodeOf(c.source);
      const t = this.nodeOf(c.target);
      if (s === t || !filledIds.has(s) || !filledIds.has(t)) continue;
      const key = `${s}->${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: s, target: t });
    }

    const graph: PromptGraph = {
      nodes: filled.map((n) => ({ id: n.id, text: this.nodeLabel(n) })),
      edges,
    };

    this.api.compilePrompt(graph, this.selectedAgent() || undefined).subscribe({
      next: (r) => {
        this.compiledPrompt.set((r.prompt || '').trim());
        this.compiling.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.error || 'error');
        this.compiling.set(false);
      },
    });
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.compiledPrompt());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  sendToChat(): void {
    const prompt = this.compiledPrompt().trim();
    if (!prompt) return;
    const channel = this.selectedAgent() || 'main';
    this.chat.switchTab(channel);
    this.chat.sendMessage(prompt, channel);
    this.complementos.close();
    this.router.navigate(['/']);
  }
}

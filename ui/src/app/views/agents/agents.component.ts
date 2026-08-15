import { Component, computed, effect, inject, OnInit, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, Agent, ModelOption } from '../../services/api.service';
import { groupModels, modelLabel } from '../../shared/model-groups';
import { AgentsService } from '../../services/agents.service';
import { ChatService } from '../../services/chat.service';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './agents.component.html',
  styleUrl: './agents.component.css',
})
export class AgentsComponent implements OnInit {
  agentsService = inject(AgentsService);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private chat = inject(ChatService);

  // Agent id requested via ?select= (agents may not be loaded yet on arrival)
  private pendingSelect = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.pendingSelect();
      if (!id) return;
      const agent = this.agentsService.agents().find(a => a.id === id);
      if (agent) {
        this.pendingSelect.set(null);
        this.selectAgent(agent);
      }
    });
  }

  selectedAgent = signal<Agent | null>(null);
  uploading = signal(false);
  uploadError = signal('');

  // Rename
  editingName = signal(false);
  nameInput = signal('');
  renameError = signal('');

  // Config dropdowns
  models = signal<ModelOption[]>([]);
  defaultModel = signal('');

  // Model dropdowns grouped by company (A→Z, models A→Z). The default model is
  // shown starred on its own at the top, so it's excluded here to avoid an empty
  // group. modelLabel strips the redundant "APIkey · Company:" prefix.
  modelLabel = modelLabel;
  // Todos los modelos agrupados. El estado "Automático" (modelo vacío) se ofrece
  // como una opción propia en la plantilla, no filtrando la lista.
  groupedModels = computed(() => groupModels(this.models()));

  // Same grouping for the "Tipo" (engine) selector, but over the models that are
  // compatible with the selected agent's worker type (see engineModels).
  groupedEngineModels = computed(() => groupModels(this.engineModels));
  savingConfig = signal(false);
  configSaved = signal(false);

  workerTypes = ['coder', 'general', 'graphic', 'video'];

  // "Tipo": generation engine the worker uses for this agent's tasks.
  // 'auto' → the worker picks (graphic → default image engine, video → Leonardo,
  // coder/general → the agent's chat model). Persisted as agentConfigs.graphicEngine.
  engine = signal('auto');

  // Resolución/aspecto for image & video generation; disabled for text workers
  resolutions = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'];
  resolution = signal('auto');

  get resolutionDisabled(): boolean {
    const wt = this.selectedAgent()?.workerType ?? 'coder';
    return wt === 'general' || wt === 'coder';
  }

  fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  // ── Create agent ──
  creatingAgent = signal(false);      // modal open
  newAgentName = signal('');
  newAgentWorker = signal('general');
  newAgentModel = signal('');         // '' → default model
  createSaving = signal(false);
  createError = signal('');

  openCreateAgent(): void {
    this.newAgentName.set('');
    this.newAgentWorker.set('general');
    this.newAgentModel.set('');
    this.createError.set('');
    this.creatingAgent.set(true);
  }

  closeCreateAgent(): void {
    this.creatingAgent.set(false);
  }

  confirmCreateAgent(): void {
    const name = this.newAgentName().trim();
    if (!name || this.createSaving()) return;
    this.createSaving.set(true);
    this.createError.set('');
    this.api.createAgent({
      name,
      workerType: this.newAgentWorker(),
      model: this.newAgentModel() || undefined,
    }).subscribe({
      next: res => {
        this.createSaving.set(false);
        this.creatingAgent.set(false);
        this.agentsService.fetch();
        this.pendingSelect.set(res.id); // select it once the refreshed list arrives
      },
      error: err => {
        this.createSaving.set(false);
        this.createError.set(err?.error?.error ?? 'Create failed');
      },
    });
  }

  // ── Personality files (soul, tools, memory…) ──
  agentFiles = signal<string[]>([]);
  editingFile = signal<string | null>(null); // filename open in the floating editor
  fileContent = signal('');
  fileLoading = signal(false);
  fileSaving = signal(false);
  fileSaved = signal(false);
  fileError = signal(false);

  private readonly fileEmojis: Record<string, string> = {
    agent: 'agents', soul: 'soul', skill: 'skill', tools: 'tools', memory: 'memory', heartbeat: 'heartbeat',
  };

  // "elena.soul.md" → "soul"
  fileType(filename: string): string {
    const parts = filename.split('.');
    return parts.length >= 3 ? parts[parts.length - 2] : filename;
  }

  fileEmoji(filename: string): string {
    return this.fileEmojis[this.fileType(filename)] ?? 'file';
  }

  private loadFiles(agentId: string): void {
    this.agentFiles.set([]);
    this.api.getAgentFiles(agentId).subscribe(files => {
      if (this.selectedAgent()?.id === agentId) this.agentFiles.set(files);
    });
  }

  openFile(filename: string): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    this.editingFile.set(filename);
    this.fileContent.set('');
    this.fileError.set(false);
    this.fileSaved.set(false);
    this.fileLoading.set(true);
    this.api.getAgentFile(agent.id, filename).subscribe({
      next: r => { this.fileLoading.set(false); this.fileContent.set(r.content); },
      error: () => { this.fileLoading.set(false); this.fileError.set(true); },
    });
  }

  saveFile(): void {
    const agent = this.selectedAgent();
    const filename = this.editingFile();
    if (!agent || !filename || this.fileLoading()) return;
    this.fileSaving.set(true);
    this.fileError.set(false);
    this.api.saveAgentFile(agent.id, filename, this.fileContent()).subscribe({
      next: () => {
        this.fileSaving.set(false);
        this.fileSaved.set(true);
        setTimeout(() => this.closeFile(), 700);
      },
      error: () => { this.fileSaving.set(false); this.fileError.set(true); },
    });
  }

  closeFile(): void {
    this.editingFile.set(null);
  }

  ngOnInit(): void {
    this.agentsService.fetch();
    this.api.getModels().subscribe(m => this.models.set(m));
    this.api.getConfig().subscribe(c => this.defaultModel.set(c.defaultModel ?? ''));
    this.route.queryParamMap.subscribe(params => {
      const id = params.get('select');
      if (id) this.pendingSelect.set(id);
      if (params.get('new')) this.openCreateAgent();
    });
  }

  selectAgent(agent: Agent): void {
    this.selectedAgent.set(agent);
    this.uploadError.set('');
    this.renameError.set('');
    this.editingName.set(false);
    this.engine.set('auto');
    this.resolution.set('auto');
    this.editingFile.set(null);
    this.loadFiles(agent.id);
    this.api.getAgentConfig(agent.id).subscribe(cfg => {
      if (this.selectedAgent()?.id === agent.id) {
        this.engine.set((cfg['graphicEngine'] as string) || 'auto');
        this.resolution.set((cfg['resolution'] as string) || 'auto');
      }
    });
  }

  // Salida hacia la conversación de este agente (abre su pestaña si no existe).
  // Es el camino de vuelta cuando el panel lateral de agentes está minimizado.
  openChat(agent: Agent): void {
    this.chat.openAgentTab(agent.id, agent.name, agent.avatarUrl);
    this.router.navigate(['/']);
  }

  // ── Avatar ──
  openFilePicker(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const agent = this.selectedAgent();
    if (!file || !agent) return;

    if (file.size > 2 * 1024 * 1024) {
      this.uploadError.set('Max 2MB');
      return;
    }

    this.uploading.set(true);
    this.uploadError.set('');
    this.api.uploadAvatar(agent.id, file).subscribe({
      next: (res) => {
        this.uploading.set(false);
        this.agentsService.fetch();
        this.selectedAgent.update(a => a ? { ...a, avatarUrl: res.avatarUrl } : a);
      },
      error: (err) => {
        this.uploading.set(false);
        this.uploadError.set(err?.error?.error ?? 'Upload failed');
      },
    });
    input.value = '';
  }

  // ── Rename ──
  startRename(): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    this.nameInput.set(agent.id);
    this.renameError.set('');
    this.editingName.set(true);
  }

  confirmRename(): void {
    const agent = this.selectedAgent();
    const newId = this.nameInput().trim().toLowerCase();
    if (!agent || !newId || newId === agent.id) {
      this.editingName.set(false);
      return;
    }
    this.api.renameAgent(agent.id, newId).subscribe({
      next: (res) => {
        this.editingName.set(false);
        this.agentsService.fetch();
        this.selectedAgent.update(a => a ? {
          ...a,
          id: res.id,
          name: res.id.charAt(0).toUpperCase() + res.id.slice(1),
          avatarUrl: a.avatarUrl ? a.avatarUrl.replace(`/avatars/${agent.id}/`, `/avatars/${res.id}/`) : a.avatarUrl,
        } : a);
        this.loadFiles(res.id); // filenames include the agent id
      },
      error: (err) => this.renameError.set(err?.error?.error ?? 'Rename failed'),
    });
  }

  cancelRename(): void {
    this.editingName.set(false);
    this.renameError.set('');
  }

  // ── Worker & Model config ──
  // Modelo crudo del agente: vacío = "Automático" (sigue el modelo por defecto
  // global). No se resuelve al default aquí para que el selector muestre
  // "Automático" en vez de un modelo concreto.
  get currentModel(): string {
    return this.selectedAgent()?.llmModel || '';
  }

  // Models compatible with the selected agent's worker type
  get engineModels(): ModelOption[] {
    const wt = this.selectedAgent()?.workerType ?? 'coder';
    const all = this.models();
    switch (wt) {
      case 'graphic':
        return all.filter(m => m.isImage || m.type === 'image');
      case 'video':
        return all.filter(m => m.isVideo || m.type === 'video');
      case 'coder':
        return all.filter(m => m.type === 'coder' || m.type === 'chat' || (!m.type && !m.isImage && !m.isVideo));
      default:
        return all;
    }
  }

  onWorkerChange(workerType: string): void {
    // Engine compatibility changes with the worker → back to automatic
    this.engine.set('auto');
    this.saveConfig({ workerType, graphicEngine: 'auto' });
  }

  onEngineChange(engine: string): void {
    this.engine.set(engine);
    this.saveConfig({ graphicEngine: engine });
  }

  onResolutionChange(resolution: string): void {
    this.resolution.set(resolution);
    this.saveConfig({ resolution });
  }

  onModelChange(model: string): void {
    this.saveConfig({ model });
  }

  private saveConfig(partial: { model?: string; workerType?: string; graphicEngine?: string; resolution?: string }): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    const payload = {
      model: partial.model ?? this.currentModel,
      workerType: partial.workerType ?? agent.workerType ?? 'coder',
      graphicEngine: partial.graphicEngine ?? this.engine(),
      resolution: partial.resolution ?? this.resolution(),
    };
    this.savingConfig.set(true);
    this.api.saveAgentConfig(agent.id, payload).subscribe({
      next: () => {
        this.savingConfig.set(false);
        this.configSaved.set(true);
        setTimeout(() => this.configSaved.set(false), 2000);
        this.selectedAgent.update(a => a ? { ...a, llmModel: payload.model, workerType: payload.workerType } : a);
        this.agentsService.fetch();
      },
      error: () => this.savingConfig.set(false),
    });
  }

  statusColor(status: string): string {
    switch (status) {
      case 'online': return 'var(--status-online)';
      case 'working': return 'var(--status-working)';
      default: return 'var(--status-offline)';
    }
  }
}

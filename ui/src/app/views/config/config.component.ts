import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, AppConfig, ChatGPTStatus, ModelOption } from '../../services/api.service';
import { groupModels, modelLabel } from '../../shared/model-groups';
import { IconComponent } from '../../components/icon/icon.component';

export interface DesktopSettings {
  closeToTray: boolean;
  launchAtLogin: boolean;
  startInTray: boolean;
  canLaunchAtLogin: boolean;
}

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './config.component.html',
  styleUrl: './config.component.css',
})
export class ConfigComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  translate = inject(TranslateService);

  config = signal<Partial<AppConfig>>({});
  models = signal<ModelOption[]>([]);
  isSaving = signal(false);
  saveSuccess = signal(false);

  // Saved default model that no longer exists in the providers' lists (e.g. the
  // local LLM was renamed) — rendered as its own option so the select is never blank.
  missingModel = computed(() => {
    const dm = this.config().defaultModel;
    if (!dm) return null;
    return this.models().some(m => m.id === dm) ? null : dm;
  });

  // Same for the routing model (empty = the default model does the routing).
  missingRouterModel = computed(() => {
    const rm = this.config().routerModel;
    if (!rm) return null;
    return this.models().some(m => m.id === rm) ? null : rm;
  });

  // Sorted alphabetically by company so the grid stays readable as more are added.
  apiKeyFields = [
    { key: 'anthropicKey', label: 'Anthropic' },
    { key: 'deepseekKey', label: 'DeepSeek' },
    { key: 'glmKey', label: 'GLM (Z.ai)' },
    { key: 'geminiKey', label: 'Google Gemini' },
    { key: 'groqKey', label: 'Groq' },
    { key: 'kimiKey', label: 'Kimi (Moonshot)' },
    { key: 'leonardoKey', label: 'Leonardo AI' },
    { key: 'minimaxKey', label: 'MiniMax' },
    { key: 'mistralKey', label: 'Mistral' },
    { key: 'openaiKey', label: 'OpenAI' },
    { key: 'openrouterKey', label: 'OpenRouter' },
    { key: 'qwenKey', label: 'Qwen' },
    { key: 'xaiKey', label: 'xAI / Grok' },
  ];

  // Strips the redundant "APIkey · Company:" prefix for display inside a group.
  modelLabel = modelLabel;

  // Models grouped by company, both companies and their models sorted A→Z.
  groupedModels = computed(() => groupModels(this.models()));

  // Desktop-only preferences (tray, start with the OS), served by the Electron
  // preload. Absent in the browser / server mode, so the section hides.
  desktop = (window as unknown as { hydraDesktop?: { settings?: { get(): Promise<DesktopSettings>; set(p: Partial<DesktopSettings>): Promise<DesktopSettings> } } }).hydraDesktop?.settings;
  desktopSettings = signal<DesktopSettings | null>(null);

  // Network access (HYDRA_HOST): the token to type on other devices, shown only here.
  network = signal<{ open: boolean; host: string; port: number; token?: string } | null>(null);
  showToken = signal(false);
  tokenCopied = signal(false);

  copyToken(): void {
    const t = this.network()?.token;
    if (!t) return;
    navigator.clipboard?.writeText(t).then(() => { this.tokenCopied.set(true); setTimeout(() => this.tokenCopied.set(false), 1500); }).catch(() => {});
  }

  // Global mode of the prompt-injection defense (per-agent choice counts only while this is 'ask').
  securityMode = signal<'ask' | 'trusted' | 'off'>('ask');

  setSecurityMode(mode: 'ask' | 'trusted' | 'off'): void {
    this.securityMode.set(mode);
    this.api.setSecurityMode(mode).subscribe();
  }

  // The ChatGPT plan (Sign in with ChatGPT): who is connected, the sign-in in progress and the
  // models the plan serves. Null while the key-proxy has not answered (or has no such support).
  chatgpt = signal<ChatGPTStatus | null>(null);
  chatgptBusy = signal(false);
  chatgptCopied = signal(false);
  private chatgptPoll?: ReturnType<typeof setInterval>;

  // The connection date in the interface language (the DatePipe would use the browser's).
  formatDate(iso?: string): string {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(this.translate.currentLang() || undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso.slice(0, 10); }
  }

  loadChatGPT(): void {
    this.api.getChatGPT().subscribe({ next: s => { this.chatgpt.set(s); if (s.pending) this.watchChatGPT(); }, error: () => this.chatgpt.set(null) });
  }

  // While the browser tab is open the status is polled: the callback lands in the key-proxy, not here.
  private watchChatGPT(): void {
    if (this.chatgptPoll) return;
    this.chatgptPoll = setInterval(() => this.api.getChatGPT().subscribe({
      next: s => {
        this.chatgpt.set(s);
        if (s.pending) return;
        this.stopChatGPTWatch();
        if (s.connected) this.api.getModels().subscribe(m => this.models.set(m));
      },
      error: () => {},
    }), 2000);
  }

  private stopChatGPTWatch(): void {
    if (this.chatgptPoll) clearInterval(this.chatgptPoll);
    this.chatgptPoll = undefined;
  }

  ngOnDestroy(): void { this.stopChatGPTWatch(); }

  connectChatGPT(): void {
    this.chatgptBusy.set(true);
    this.api.chatgptAction('signin').subscribe({
      next: r => {
        this.chatgptBusy.set(false);
        // The system browser on the desktop (the shell routes window.open there); a tab in the browser.
        if (r.url) window.open(r.url, '_blank', 'noopener');
        this.loadChatGPT();
      },
      error: e => {
        this.chatgptBusy.set(false);
        this.chatgpt.update(s => ({ ...(s ?? { connected: false, status: 'disconnected', models: [], pending: null }), lastError: e?.error?.error || e?.message || 'unknown' }));
      },
    });
  }

  cancelChatGPT(): void {
    this.api.chatgptAction('cancel').subscribe({ next: () => { this.stopChatGPTWatch(); this.loadChatGPT(); }, error: () => {} });
  }

  disconnectChatGPT(): void {
    this.chatgptBusy.set(true);
    this.api.chatgptAction('signout').subscribe({
      next: () => { this.chatgptBusy.set(false); this.loadChatGPT(); this.api.getModels().subscribe(m => this.models.set(m)); },
      error: () => this.chatgptBusy.set(false),
    });
  }

  refreshChatGPTModels(): void {
    this.chatgptBusy.set(true);
    this.api.chatgptAction('models').subscribe({
      next: () => { this.chatgptBusy.set(false); this.loadChatGPT(); this.api.getModels().subscribe(m => this.models.set(m)); },
      error: () => this.chatgptBusy.set(false),
    });
  }

  copyChatGPTLink(): void {
    const u = this.chatgpt()?.pending?.url;
    if (!u) return;
    navigator.clipboard?.writeText(u).then(() => { this.chatgptCopied.set(true); setTimeout(() => this.chatgptCopied.set(false), 1500); }).catch(() => {});
  }

  ngOnInit(): void {
    this.fetchConfig();
    this.loadChatGPT();
    this.api.getSecurityMode().subscribe({ next: r => this.securityMode.set(r.mode), error: () => {} });
    this.api.getNetworkAccess().subscribe({ next: r => this.network.set(r), error: () => {} });
    this.desktop?.get().then(s => this.desktopSettings.set(s)).catch(() => {});
  }

  setDesktop(patch: Partial<DesktopSettings>): void {
    this.desktop?.set(patch).then(s => this.desktopSettings.set(s)).catch(() => {});
  }

  fetchConfig(): void {
    this.api.getConfig().subscribe(c => this.config.set(c));
    this.api.getModels().subscribe(m => this.models.set(m));
  }

  updateField(key: string, value: string): void {
    this.config.update(c => ({ ...c, [key]: value }));
  }

  save(): void {
    this.isSaving.set(true);
    this.api.saveConfig(this.config()).subscribe({
      next: () => {
        this.isSaving.set(false);
        this.saveSuccess.set(true);
        setTimeout(() => this.saveSuccess.set(false), 3000);
        this.api.getModels().subscribe(m => this.models.set(m));
      },
      error: () => this.isSaving.set(false),
    });
  }

  setLang(lang: string): void {
    this.translate.use(lang);
    localStorage.setItem('hydra_lang', lang);
    // En el escritorio, refleja el idioma en el menú nativo y el Acerca de.
    (window as unknown as { hydraDesktop?: { setLang?: (l: string) => void } })
      .hydraDesktop?.setLang?.(lang);
  }
}

import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, AppConfig, ModelOption } from '../../services/api.service';
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
export class ConfigComponent implements OnInit {
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

  // Global mode of the prompt-injection defense (per-agent choice counts only while this is 'ask').
  securityMode = signal<'ask' | 'trusted' | 'off'>('ask');

  setSecurityMode(mode: 'ask' | 'trusted' | 'off'): void {
    this.securityMode.set(mode);
    this.api.setSecurityMode(mode).subscribe();
  }

  ngOnInit(): void {
    this.fetchConfig();
    this.api.getSecurityMode().subscribe({ next: r => this.securityMode.set(r.mode), error: () => {} });
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

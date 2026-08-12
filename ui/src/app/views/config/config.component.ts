import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, AppConfig, ModelOption } from '../../services/api.service';

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
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

  apiKeyFields = [
    { key: 'openaiKey', label: 'OpenAI' },
    { key: 'geminiKey', label: 'Google Gemini' },
    { key: 'groqKey', label: 'Groq' },
    { key: 'xaiKey', label: 'xAI / Grok' },
    { key: 'anthropicKey', label: 'Anthropic' },
    { key: 'leonardoKey', label: 'Leonardo AI' },
    { key: 'openrouterKey', label: 'OpenRouter' },
    { key: 'mistralKey', label: 'Mistral' },
  ];

  ngOnInit(): void {
    this.fetchConfig();
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
  }
}

import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { IconComponent } from '../../components/icon/icon.component';
import { ApiService, Agent, AppConfig, TelegramIntegration, GitHubIntegration } from '../../services/api.service';

@Component({
  selector: 'app-herramientas',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './herramientas.component.html',
  styleUrl: './herramientas.component.css',
})
export class HerramientasComponent implements OnInit {
  private api = inject(ApiService);

  telegram = signal<TelegramIntegration | null>(null);
  github = signal<GitHubIntegration | null>(null);
  agents = signal<Agent[]>([]);

  tokenInput = signal('');
  tokenSaved = signal(false);
  cfgSaved = signal(false);
  newAllowId = signal('');

  ghTokenInput = signal('');
  ghTokenSaved = signal(false);

  // Future connectors, shown as disabled "coming soon" cards to convey the idea.
  comingSoon = ['discord', 'signal', 'reddit'];

  ngOnInit(): void {
    this.api.getTelegramIntegration().subscribe(t => this.telegram.set(t));
    this.api.getGitHubIntegration().subscribe(g => this.github.set(g));
    this.api.getAgents().subscribe(a => this.agents.set(a));
  }

  // ── GitHub ──
  private patchGithub(part: Partial<GitHubIntegration>): void {
    const cur = this.github();
    if (cur) this.github.set({ ...cur, ...part });
  }

  toggleGithub(): void {
    const g = this.github();
    if (!g) return;
    const enabled = !g.enabled;
    this.patchGithub({ enabled });
    this.api.saveGitHubIntegration({ enabled }).subscribe();
  }

  saveGithubToken(): void {
    const value = this.ghTokenInput().trim();
    if (!value) return;
    // Same firewall as the Telegram token: the PAT goes ONLY to the key store.
    this.api.saveConfig({ githubToken: value } as Partial<AppConfig>).subscribe(() => {
      this.patchGithub({ tokenConfigured: true });
      this.ghTokenInput.set('');
      this.ghTokenSaved.set(true);
      setTimeout(() => this.ghTokenSaved.set(false), 2000);
    });
  }

  private patch(part: Partial<TelegramIntegration>): void {
    const cur = this.telegram();
    if (cur) this.telegram.set({ ...cur, ...part });
  }

  private flashCfgSaved(): void {
    this.cfgSaved.set(true);
    setTimeout(() => this.cfgSaved.set(false), 2000);
  }

  toggleEnabled(): void {
    const t = this.telegram();
    if (!t) return;
    const enabled = !t.enabled;
    this.patch({ enabled });
    this.api.saveTelegramIntegration({ enabled }).subscribe();
  }

  saveToken(): void {
    const value = this.tokenInput().trim();
    if (!value) return;
    // Reuse the POST /config contract: the real token goes ONLY to the keystore
    // (via PROVIDER_KEY_NAMES); DB/.env keep the "proxy" placeholder.
    this.api.saveConfig({ telegramBotToken: value } as Partial<AppConfig>).subscribe(() => {
      this.patch({ tokenConfigured: true });
      this.tokenInput.set('');
      this.tokenSaved.set(true);
      setTimeout(() => this.tokenSaved.set(false), 2000);
    });
  }

  onDefaultAgentChange(id: string): void {
    this.patch({ defaultAgent: id });
    this.api.saveTelegramIntegration({ defaultAgent: id }).subscribe(() => this.flashCfgSaved());
  }

  toggleNotifyCron(): void {
    const t = this.telegram();
    if (!t) return;
    const cron = !(t.notifications?.cron !== false);
    this.patch({ notifications: { cron } });
    this.api.saveTelegramIntegration({ notifications: { cron } }).subscribe(() => this.flashCfgSaved());
  }

  generatePairingCode(): void {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    this.patch({ pairingCode: code });
    this.api.saveTelegramIntegration({ pairingCode: code }).subscribe(() => this.flashCfgSaved());
  }

  addAllowId(): void {
    const n = Number(this.newAllowId().trim());
    const t = this.telegram();
    if (!t || !Number.isFinite(n) || n === 0) return;
    if (t.allowlist.includes(n)) {
      this.newAllowId.set('');
      return;
    }
    const allowlist = [...t.allowlist, n];
    this.patch({ allowlist });
    this.newAllowId.set('');
    this.api.saveTelegramIntegration({ allowlist }).subscribe(() => this.flashCfgSaved());
  }

  removeAllowId(n: number): void {
    const t = this.telegram();
    if (!t) return;
    const allowlist = t.allowlist.filter(x => x !== n);
    this.patch({ allowlist });
    this.api.saveTelegramIntegration({ allowlist }).subscribe(() => this.flashCfgSaved());
  }
}

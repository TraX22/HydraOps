import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { IconComponent } from '../../components/icon/icon.component';
import { SkillsCardComponent } from './skills-card/skills-card.component';
import { ConnectionsCardComponent } from './connections-card/connections-card.component';
import { XCardComponent } from './x-card/x-card.component';
import { ApiService, Agent, AppConfig, TelegramIntegration, GitHubIntegration, HuggingFaceIntegration, CivitaiIntegration } from '../../services/api.service';

@Component({
  selector: 'app-herramientas',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent, SkillsCardComponent, ConnectionsCardComponent, XCardComponent],
  templateUrl: './herramientas.component.html',
  styleUrl: './herramientas.component.css',
})
export class HerramientasComponent implements OnInit {
  private api = inject(ApiService);

  telegram = signal<TelegramIntegration | null>(null);
  github = signal<GitHubIntegration | null>(null);
  huggingface = signal<HuggingFaceIntegration | null>(null);
  civitai = signal<CivitaiIntegration | null>(null);
  agents = signal<Agent[]>([]);

  tokenInput = signal('');
  tokenSaved = signal(false);
  cfgSaved = signal(false);
  newAllowId = signal('');

  ghTokenInput = signal('');
  ghTokenSaved = signal(false);

  hfTokenInput = signal('');
  hfTokenSaved = signal(false);

  cvKeyInput = signal('');
  cvKeySaved = signal(false);

  // Dots shown in a configured token field so it reads as "set" at a glance,
  // mirroring the masked API-key fields in Config. The value never contains the
  // real token (we only know it exists); the password input renders it as dots.
  // Focusing a masked field clears it so a new token can be typed.
  readonly tokenMask = '••••••••••••••••';

  // Future connectors, shown as disabled "coming soon" cards to convey the idea.
  comingSoon = ['discord', 'signal', 'reddit'];

  ngOnInit(): void {
    this.api.getTelegramIntegration().subscribe(t => {
      this.telegram.set(t);
      if (t.tokenConfigured) this.tokenInput.set(this.tokenMask);
    });
    this.api.getGitHubIntegration().subscribe(g => {
      this.github.set(g);
      if (g.tokenConfigured) this.ghTokenInput.set(this.tokenMask);
    });
    this.loadHuggingFace();
    this.loadCivitai();
    this.api.getAgents().subscribe(a => this.agents.set(a));
  }

  private loadCivitai(): void {
    this.api.getCivitaiIntegration().subscribe(c => {
      this.civitai.set(c);
      if (c.tokenConfigured) this.cvKeyInput.set(this.tokenMask);
    });
  }

  private loadHuggingFace(): void {
    this.api.getHuggingFaceIntegration().subscribe(h => {
      this.huggingface.set(h);
      if (h.tokenConfigured) this.hfTokenInput.set(this.tokenMask);
    });
  }

  // Clear the mask on focus so the user types a fresh token; restore it on blur
  // if they left it empty and a token is still configured.
  onTokenFocus(): void { if (this.tokenInput() === this.tokenMask) this.tokenInput.set(''); }
  onTokenBlur(): void { if (!this.tokenInput().trim() && this.telegram()?.tokenConfigured) this.tokenInput.set(this.tokenMask); }
  onGhTokenFocus(): void { if (this.ghTokenInput() === this.tokenMask) this.ghTokenInput.set(''); }
  onGhTokenBlur(): void { if (!this.ghTokenInput().trim() && this.github()?.tokenConfigured) this.ghTokenInput.set(this.tokenMask); }
  onCvKeyFocus(): void { if (this.cvKeyInput() === this.tokenMask) this.cvKeyInput.set(''); }
  onCvKeyBlur(): void { if (!this.cvKeyInput().trim() && this.civitai()?.tokenConfigured) this.cvKeyInput.set(this.tokenMask); }
  onHfTokenFocus(): void { if (this.hfTokenInput() === this.tokenMask) this.hfTokenInput.set(''); }
  onHfTokenBlur(): void { if (!this.hfTokenInput().trim() && this.huggingface()?.tokenConfigured) this.hfTokenInput.set(this.tokenMask); }

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
    if (!value || value === this.tokenMask) return; // mask = unchanged
    // Same firewall as the Telegram token: the PAT goes ONLY to the key store.
    this.api.saveConfig({ githubToken: value } as Partial<AppConfig>).subscribe(() => {
      this.patchGithub({ tokenConfigured: true });
      this.ghTokenInput.set(this.tokenMask); // show dots, not an empty field
      this.ghTokenSaved.set(true);
      setTimeout(() => this.ghTokenSaved.set(false), 2000);
    });
  }

  // ── Civitai ──
  toggleCivitai(): void {
    const c = this.civitai();
    if (!c) return;
    const enabled = !c.enabled;
    this.civitai.set({ ...c, enabled });
    this.api.saveCivitaiIntegration({ enabled }).subscribe();
  }

  toggleCivitaiAdult(): void {
    const c = this.civitai();
    if (!c) return;
    this.api.setCivitaiAdult(!c.allowAdult).subscribe(r => this.civitai.set({ ...c, allowAdult: r.allowAdult }));
  }

  saveCivitaiKey(): void {
    const value = this.cvKeyInput().trim();
    if (!value || value === this.tokenMask) return; // mask = unchanged
    // The key goes ONLY to the key store; reloading asks Civitai whose it is.
    this.api.saveConfig({ civitaiKey: value } as Partial<AppConfig>).subscribe(() => {
      this.cvKeySaved.set(true);
      setTimeout(() => this.cvKeySaved.set(false), 2000);
      this.loadCivitai();
    });
  }

  // ── Hugging Face ──
  toggleHuggingFace(): void {
    const h = this.huggingface();
    if (!h) return;
    const enabled = !h.enabled;
    this.huggingface.set({ ...h, enabled });
    this.api.saveHuggingFaceIntegration({ enabled }).subscribe();
  }

  saveHuggingFaceToken(): void {
    const value = this.hfTokenInput().trim();
    if (!value || value === this.tokenMask) return; // mask = unchanged
    // The token goes ONLY to the key store; reloading asks Hugging Face whose it is.
    this.api.saveConfig({ huggingfaceToken: value } as Partial<AppConfig>).subscribe(() => {
      this.hfTokenSaved.set(true);
      setTimeout(() => this.hfTokenSaved.set(false), 2000);
      this.loadHuggingFace();
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
    if (!value || value === this.tokenMask) return; // mask = unchanged
    // Reuse the POST /config contract: the real token goes ONLY to the keystore
    // (via PROVIDER_KEY_NAMES); DB/.env keep the "proxy" placeholder.
    this.api.saveConfig({ telegramBotToken: value } as Partial<AppConfig>).subscribe(() => {
      this.patch({ tokenConfigured: true });
      this.tokenInput.set(this.tokenMask); // show dots, not an empty field
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
    const cronFailures = t.notifications?.cronFailures !== false;
    this.patch({ notifications: { cron, cronFailures } });
    this.api.saveTelegramIntegration({ notifications: { cron } }).subscribe(() => this.flashCfgSaved());
  }

  toggleNotifyHeldActions(): void {
    const t = this.telegram();
    if (!t) return;
    const heldActions = !(t.notifications?.heldActions !== false);
    this.patch({ notifications: { ...(t.notifications ?? {}), heldActions } });
    this.api.saveTelegramIntegration({ notifications: { heldActions } }).subscribe(() => this.flashCfgSaved());
  }

  toggleNotifyCronFailures(): void {
    const t = this.telegram();
    if (!t) return;
    const cron = t.notifications?.cron !== false;
    const cronFailures = !(t.notifications?.cronFailures !== false);
    this.patch({ notifications: { cron, cronFailures } });
    this.api.saveTelegramIntegration({ notifications: { cronFailures } }).subscribe(() => this.flashCfgSaved());
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

import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, Agent, XAccount, XIntegration } from '../../../services/api.service';

const POLL_MS = 3000;

/**
 * Herramientas → X. One card: the user's X app (its client id and secret go to the key
 * store), the accounts connected to it, one sign-in per account, and which agents may
 * publish with each account. Publishing itself is a tool that always asks first; this
 * card only decides who may ask for which account.
 */
@Component({
  selector: 'app-x-card',
  standalone: true,
  imports: [TranslatePipe, RouterLink],
  templateUrl: './x-card.component.html',
  styleUrl: './x-card.component.css',
})
export class XCardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private translate = inject(TranslateService);

  x = signal<XIntegration | null>(null);
  agents = signal<Agent[]>([]);
  error = signal('');
  busy = signal(false);
  saved = signal(false);

  // The app's credentials, typed once; the secret is never read back.
  clientId = signal('');
  clientSecret = signal('');
  /** The https address of the user's own copy of the callback page, as registered in the X app. */
  redirectUri = signal('');
  readonly mask = '••••••••••••••••';

  // Connecting one more account: the link, and the address the user pastes when the browser was elsewhere.
  link = signal<{ url: string; expiresAt: string } | null>(null);
  pasteUrl = signal('');
  copied = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Agents not yet allowed on a given account, for its "+ agent" picker. */
  pickable = computed(() => {
    const all = this.agents();
    return (account: XAccount) => all.filter(a => !account.agents.includes(a.id));
  });

  ngOnInit(): void {
    this.reload();
    this.api.getAgents().subscribe({ next: a => this.agents.set(a), error: () => {} });
  }

  ngOnDestroy(): void { this.stopPolling(); }

  reload(): void {
    this.api.getXIntegration().subscribe({
      next: x => this.apply(x),
      error: e => this.error.set(this.errorText(e)),
    });
  }

  private apply(x: XIntegration): void {
    this.x.set(x);
    if (x.clientId && !this.clientId()) this.clientId.set(x.clientId);
    if (x.appConfigured && !this.clientSecret()) this.clientSecret.set(this.mask);
    if (x.redirectUri && !this.redirectUri()) this.redirectUri.set(x.redirectUri);
    if (x.pending) {
      if (!this.link() || this.link()!.url !== x.pending.url) this.link.set({ url: x.pending.url, expiresAt: x.pending.expiresAt });
      this.startPolling();
    } else {
      // The sign-in ended (an account came in, or it expired): the link is no longer valid.
      if (this.link()) { this.link.set(null); this.pasteUrl.set(''); }
      this.stopPolling();
      if (x.lastError) this.error.set(x.lastError);
    }
  }

  // ── The app ──

  onSecretFocus(): void { if (this.clientSecret() === this.mask) this.clientSecret.set(''); }
  onSecretBlur(): void { if (!this.clientSecret().trim() && this.x()?.appConfigured) this.clientSecret.set(this.mask); }

  saveApp(): void {
    if (this.busy()) return;
    const id = this.clientId().trim();
    const secret = this.clientSecret() === this.mask ? '' : this.clientSecret().trim();
    if (!id) return;
    this.busy.set(true);
    this.error.set('');
    this.api.saveXApp(id, secret, this.redirectUri().trim()).subscribe({
      next: x => { this.busy.set(false); this.apply(x); this.clientSecret.set(this.mask); this.flash(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  // ── Connecting accounts ──

  connect(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.connectXAccount().subscribe({
      next: l => { this.busy.set(false); this.link.set(l); this.copied.set(false); this.startPolling(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  cancel(): void {
    this.api.cancelXConnect().subscribe({ next: x => { this.link.set(null); this.pasteUrl.set(''); this.apply(x); }, error: () => {} });
  }

  copyLink(): void {
    const l = this.link();
    if (!l) return;
    navigator.clipboard?.writeText(l.url).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 2000); }).catch(() => {});
  }

  /** The address X sent the browser to, pasted by hand. */
  finishByHand(): void {
    const url = this.pasteUrl().trim();
    if (!url || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.finishXConnect(url).subscribe({
      next: x => { this.busy.set(false); this.link.set(null); this.pasteUrl.set(''); this.apply(x); this.flash(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.api.getXIntegration().subscribe({ next: x => this.apply(x), error: () => {} }), POLL_MS);
  }
  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Accounts ──

  toggleEnabled(): void {
    const x = this.x();
    if (!x) return;
    this.x.set({ ...x, enabled: !x.enabled });
    this.api.saveXIntegration({ enabled: !x.enabled }).subscribe({ next: n => this.apply(n), error: e => this.error.set(this.errorText(e)) });
  }

  disconnect(a: XAccount): void {
    if (this.busy()) return;
    if (!confirm(this.translate.instant('herramientas.x.disconnectConfirm', { username: a.username }))) return;
    this.busy.set(true);
    this.api.disconnectXAccount(a.id).subscribe({
      next: x => { this.busy.set(false); this.apply(x); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  addAgent(a: XAccount, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const id = select.value;
    select.value = '';
    if (!id || a.agents.includes(id)) return;
    this.setAgents(a, [...a.agents, id]);
  }

  removeAgent(a: XAccount, id: string): void {
    this.setAgents(a, a.agents.filter(x => x !== id));
  }

  private setAgents(a: XAccount, agents: string[]): void {
    const x = this.x();
    if (x) this.x.set({ ...x, accounts: x.accounts.map(k => k.id === a.id ? { ...k, agents } : k) });
    this.api.saveXIntegration({ accounts: [{ id: a.id, agents }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }

  agentName(id: string): string {
    return this.agents().find(a => a.id === id)?.name ?? id;
  }

  initial(a: XAccount): string { return (a.name || a.username || '?').charAt(0).toUpperCase(); }

  /** The day the account was connected, as the user's language writes it. */
  dateOf(a: XAccount): string {
    try { return new Date(a.connectedAt).toLocaleDateString(this.translate.currentLang() || undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return a.connectedAt.slice(0, 10); }
  }

  private flash(): void { this.saved.set(true); setTimeout(() => this.saved.set(false), 2000); }

  private errorText(e: any): string {
    const code = String(e?.error?.error ?? '');
    const known = ['bad_client_id', 'no_secret', 'app_not_configured', 'bad_redirect_uri', 'no_redirect_uri', 'state_mismatch', 'no_code', 'scope_missing', 'bad_callback_url', 'no_such_account', 'x_reauth_required'];
    if (known.includes(code)) return this.translate.instant('herramientas.x.errors.' + code);
    return String(e?.error?.message || e?.message || this.translate.instant('herramientas.x.errors.generic'));
  }
}

import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { IconComponent } from '../../../components/icon/icon.component';
import { ApiService, Agent, GmailAccount, GmailGrant, GmailIntegration, GMAIL_GRANTS } from '../../../services/api.service';

const POLL_MS = 3000;

/**
 * Herramientas → Gmail. One card: the user's Google OAuth client (its id and secret go to the
 * key store), the Gmail accounts connected through it, one sign-in per account with the
 * permissions chosen for it (read, drafts, send), and which agents may use each account.
 * Reading a mailbox asks nobody and costs nothing; a draft asks nobody either (nothing leaves
 * the account); sending always waits for the user.
 */
@Component({
  selector: 'app-gmail-card',
  standalone: true,
  imports: [TranslatePipe, RouterLink, IconComponent],
  templateUrl: './gmail-card.component.html',
  // The card vocabulary (fields, chips, connect box, account rows) is the X card's.
  styleUrls: ['../x-card/x-card.component.css', './gmail-card.component.css'],
})
export class GmailCardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private translate = inject(TranslateService);

  g = signal<GmailIntegration | null>(null);
  agents = signal<Agent[]>([]);
  error = signal('');
  busy = signal(false);
  saved = signal(false);

  // The client's credentials, typed once; the secret is never read back.
  clientId = signal('');
  clientSecret = signal('');
  readonly mask = '••••••••••••••••';

  // Connecting one more account: the permissions picked first, then the link, and the address
  // the user pastes when the browser was elsewhere.
  readonly grants = GMAIL_GRANTS;
  /** The picker is open: the user chooses what the account is for before the link exists. */
  choosing = signal(false);
  pick = signal<Record<GmailGrant, boolean>>({ read: true, compose: true, send: false });
  /** When the sign-in is to add permissions to an account already connected. */
  reconnecting = signal<GmailAccount | null>(null);
  link = signal<{ url: string; expiresAt: string; grants?: GmailGrant[] } | null>(null);
  pasteUrl = signal('');
  copied = signal(false);
  /** A grant the user switched on that the account's scopes do not cover: offer the sign-in that adds it. */
  needsReconnect = signal<{ account: GmailAccount; grant: GmailGrant } | null>(null);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Agents not yet allowed on a given account, for its "+ agent" picker. */
  pickable = computed(() => {
    const all = this.agents();
    return (account: GmailAccount) => all.filter(a => !account.agents.includes(a.id));
  });

  ngOnInit(): void {
    this.reload();
    this.api.getAgents().subscribe({ next: a => this.agents.set(a), error: () => {} });
  }

  ngOnDestroy(): void { this.stopPolling(); }

  reload(): void {
    this.api.getGmailIntegration().subscribe({
      next: g => this.apply(g, true),
      error: e => this.error.set(this.errorText(e)),
    });
  }

  /**
   * The status. The client's fields are filled from it only when asked (opening the card, after
   * saving): the poll that runs during a sign-in must never refill a field the user is editing.
   */
  private apply(g: GmailIntegration, fillFields = false): void {
    this.g.set(g);
    if (fillFields) {
      this.clientId.set(g.clientId ?? '');
      this.clientSecret.set(g.appConfigured ? this.mask : '');
    }
    if (g.pending) {
      if (!this.link() || this.link()!.url !== g.pending.url) this.link.set({ url: g.pending.url, expiresAt: g.pending.expiresAt });
      this.startPolling();
    } else {
      // The sign-in ended (an account came in, or it expired): the link is no longer valid.
      if (this.link()) { this.link.set(null); this.pasteUrl.set(''); this.reconnecting.set(null); }
      this.stopPolling();
      if (g.lastError) this.error.set(g.lastError);
    }
  }

  // ── The client ──

  onSecretFocus(): void { if (this.clientSecret() === this.mask) this.clientSecret.set(''); }
  onSecretBlur(): void { if (!this.clientSecret().trim() && this.g()?.appConfigured) this.clientSecret.set(this.mask); }

  saveApp(): void {
    if (this.busy()) return;
    const id = this.clientId().trim();
    const secret = this.clientSecret() === this.mask ? '' : this.clientSecret().trim();
    if (!id) return;
    this.busy.set(true);
    this.error.set('');
    this.api.saveGmailApp(id, secret).subscribe({
      next: g => { this.busy.set(false); this.apply(g, true); this.flash(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  // ── Connecting accounts ──

  /** Opens the permission picker for a new account (read and drafts preselected). */
  connect(): void {
    if (this.busy() || this.link()) return;
    this.reconnecting.set(null);
    this.pick.set({ read: true, compose: true, send: false });
    this.choosing.set(true);
    this.error.set('');
  }

  /** Opens the picker for an account already connected, with its grants plus the one wanted. */
  reconnect(a: GmailAccount, extra?: GmailGrant): void {
    if (this.busy() || this.link()) return;
    const on = new Set<GmailGrant>([...a.grants, ...(extra ? [extra] : [])]);
    this.pick.set({ read: true, compose: on.has('compose'), send: on.has('send') });
    this.reconnecting.set(a);
    this.needsReconnect.set(null);
    this.choosing.set(true);
    this.error.set('');
  }

  togglePick(g: GmailGrant): void {
    if (g === 'read') return;
    this.pick.update(p => ({ ...p, [g]: !p[g] }));
  }
  pickedGrants(): GmailGrant[] { const p = this.pick(); return this.grants.filter(g => p[g]); }

  /** The link, for the permissions picked. */
  startConnect(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.connectGmailAccount(this.pickedGrants()).subscribe({
      next: l => { this.busy.set(false); this.choosing.set(false); this.link.set(l); this.copied.set(false); this.startPolling(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  cancel(): void {
    this.choosing.set(false);
    this.reconnecting.set(null);
    if (!this.link()) return;
    this.api.cancelGmailConnect().subscribe({ next: g => { this.link.set(null); this.pasteUrl.set(''); this.apply(g); }, error: () => {} });
  }

  copyLink(): void {
    const l = this.link();
    if (!l) return;
    navigator.clipboard?.writeText(l.url).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 2000); }).catch(() => {});
  }

  /** The address Google sent the browser to, pasted by hand (server mode). */
  finishByHand(): void {
    const url = this.pasteUrl().trim();
    if (!url || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.finishGmailConnect(url).subscribe({
      next: g => { this.busy.set(false); this.link.set(null); this.pasteUrl.set(''); this.reconnecting.set(null); this.apply(g); this.flash(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.api.getGmailIntegration().subscribe({ next: g => this.apply(g), error: () => {} }), POLL_MS);
  }
  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Accounts ──

  toggleEnabled(): void {
    const g = this.g();
    if (!g) return;
    this.g.set({ ...g, enabled: !g.enabled });
    this.api.saveGmailIntegration({ enabled: !g.enabled }).subscribe({ next: n => this.apply(n), error: e => this.error.set(this.errorText(e)) });
  }

  disconnect(a: GmailAccount): void {
    if (this.busy()) return;
    if (!confirm(this.translate.instant('herramientas.gmail.disconnectConfirm', { email: a.email }))) return;
    this.busy.set(true);
    this.api.disconnectGmailAccount(a.id).subscribe({
      next: g => { this.busy.set(false); this.apply(g); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  /** Switches one grant of a connected account; one its scopes lack asks for a new sign-in instead. */
  toggleGrant(a: GmailAccount, g: GmailGrant): void {
    if (g === 'read' || this.busy()) return;
    const on = a.grants.includes(g);
    const grants = on ? a.grants.filter(k => k !== g) : [...a.grants, g];
    this.needsReconnect.set(null);
    this.api.setGmailGrants(a.id, grants).subscribe({
      next: n => { this.apply(n); this.flash(); },
      error: e => {
        if (String(e?.error?.error) === 'scopes_missing') this.needsReconnect.set({ account: a, grant: g });
        else this.error.set(this.errorText(e));
      },
    });
  }
  hasGrant(a: GmailAccount, g: GmailGrant): boolean { return a.grants.includes(g); }

  addAgent(a: GmailAccount, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const id = select.value;
    select.value = '';
    if (!id || a.agents.includes(id)) return;
    this.setAgents(a, [...a.agents, id]);
  }

  removeAgent(a: GmailAccount, id: string): void {
    this.setAgents(a, a.agents.filter(x => x !== id));
  }

  private setAgents(a: GmailAccount, agents: string[]): void {
    const g = this.g();
    if (g) this.g.set({ ...g, accounts: g.accounts.map(k => k.id === a.id ? { ...k, agents } : k) });
    this.api.saveGmailIntegration({ accounts: [{ id: a.id, agents }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }

  agentName(id: string): string {
    return this.agents().find(a => a.id === id)?.name ?? id;
  }

  initial(a: GmailAccount): string { return (a.name || a.email || '?').charAt(0).toUpperCase(); }

  /** The day the account was connected, as the user's language writes it. */
  dateOf(a: GmailAccount): string {
    try { return new Date(a.connectedAt).toLocaleDateString(this.translate.currentLang() || undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return a.connectedAt.slice(0, 10); }
  }

  private flash(): void { this.saved.set(true); setTimeout(() => this.saved.set(false), 2000); }

  private errorText(e: any): string {
    const code = String(e?.error?.error ?? '');
    const known = ['bad_client_id', 'no_secret', 'app_not_configured', 'bad_redirect_uri', 'state_mismatch', 'no_code', 'scope_missing', 'no_refresh_token', 'bad_callback_url', 'no_such_account', 'gmail_reauth_required', 'scopes_missing'];
    if (known.includes(code)) return this.translate.instant('herramientas.gmail.errors.' + code);
    return String(e?.error?.message || e?.message || this.translate.instant('herramientas.gmail.errors.generic'));
  }
}

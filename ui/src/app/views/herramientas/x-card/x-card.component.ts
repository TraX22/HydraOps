import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, Agent, XAccount, XGrant, XIntegration, X_GRANTS } from '../../../services/api.service';

const POLL_MS = 3000;

/**
 * Herramientas → X. One card: the user's X app (its client id and secret go to the key
 * store), the accounts connected to it, one sign-in per account with the permissions chosen
 * for it (read, publish, engage, messages), which agents may use each account, and the
 * money: what each account has spent this month against its cap, and how much one task
 * may spend reading. Publishing itself is a tool that always asks first; reads ask nobody
 * but count against the budget.
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

  // Connecting one more account: the permissions picked first, then the link, and the address
  // the user pastes when the browser was elsewhere.
  readonly grants = X_GRANTS;
  /** The picker is open: the user chooses what the account is for before the link exists. */
  choosing = signal(false);
  pick = signal<Record<XGrant, boolean>>({ read: true, publish: true, engage: false, messages: false });
  /** When the sign-in is to add permissions to an account already connected. */
  reconnecting = signal<XAccount | null>(null);
  link = signal<{ url: string; expiresAt: string; grants?: XGrant[] } | null>(null);
  pasteUrl = signal('');
  copied = signal(false);
  /** A grant the user switched on that the account's scopes do not cover: offer the sign-in that adds it. */
  needsReconnect = signal<{ account: XAccount; grant: XGrant } | null>(null);
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
      next: x => this.apply(x, true),
      error: e => this.error.set(this.errorText(e)),
    });
  }

  /**
   * The status. The app's fields are filled from it only when asked (opening the card, after
   * saving): the poll that runs during a sign-in must never refill a field the user is editing.
   */
  private apply(x: XIntegration, fillFields = false): void {
    this.x.set(x);
    if (fillFields) {
      this.clientId.set(x.clientId ?? '');
      this.clientSecret.set(x.appConfigured ? this.mask : '');
      this.redirectUri.set(x.redirectUri ?? '');
    }
    if (x.pending) {
      if (!this.link() || this.link()!.url !== x.pending.url) this.link.set({ url: x.pending.url, expiresAt: x.pending.expiresAt });
      this.startPolling();
    } else {
      // The sign-in ended (an account came in, or it expired): the link is no longer valid.
      if (this.link()) { this.link.set(null); this.pasteUrl.set(''); this.reconnecting.set(null); }
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
      next: x => { this.busy.set(false); this.apply(x, true); this.flash(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  // ── Connecting accounts ──

  /** Opens the permission picker for a new account (read and publish preselected). */
  connect(): void {
    if (this.busy() || this.link()) return;
    this.reconnecting.set(null);
    this.pick.set({ read: true, publish: true, engage: false, messages: false });
    this.choosing.set(true);
    this.error.set('');
  }

  /** Opens the picker for an account already connected, with its grants plus the one wanted. */
  reconnect(a: XAccount, extra?: XGrant): void {
    if (this.busy() || this.link()) return;
    const on = new Set<XGrant>([...a.grants, ...(extra ? [extra] : [])]);
    this.pick.set({ read: true, publish: on.has('publish'), engage: on.has('engage'), messages: on.has('messages') });
    this.reconnecting.set(a);
    this.needsReconnect.set(null);
    this.choosing.set(true);
    this.error.set('');
  }

  togglePick(g: XGrant): void {
    if (g === 'read') return;
    this.pick.update(p => ({ ...p, [g]: !p[g] }));
  }
  pickedGrants(): XGrant[] { const p = this.pick(); return this.grants.filter(g => p[g]); }

  /** The link, for the permissions picked. */
  startConnect(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.connectXAccount(this.pickedGrants()).subscribe({
      next: l => { this.busy.set(false); this.choosing.set(false); this.link.set(l); this.copied.set(false); this.startPolling(); },
      error: e => { this.busy.set(false); this.error.set(this.errorText(e)); },
    });
  }

  cancel(): void {
    this.choosing.set(false);
    this.reconnecting.set(null);
    if (!this.link()) return;
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
      next: x => { this.busy.set(false); this.link.set(null); this.pasteUrl.set(''); this.reconnecting.set(null); this.apply(x); this.flash(); },
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

  /** Switches one grant of a connected account; one its scopes lack asks for a new sign-in instead. */
  toggleGrant(a: XAccount, g: XGrant): void {
    if (g === 'read' || this.busy()) return;
    const on = a.grants.includes(g);
    const grants = on ? a.grants.filter(k => k !== g) : [...a.grants, g];
    this.needsReconnect.set(null);
    this.api.setXGrants(a.id, grants).subscribe({
      next: n => { this.apply(n); this.flash(); },
      error: e => {
        if (String(e?.error?.error) === 'scopes_missing') this.needsReconnect.set({ account: a, grant: g });
        else this.error.set(this.errorText(e));
      },
    });
  }
  hasGrant(a: XAccount, g: XGrant): boolean { return a.grants.includes(g); }

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

  togglePremium(a: XAccount): void {
    const premium = !a.premium;
    const x = this.x();
    if (x) this.x.set({ ...x, accounts: x.accounts.map(k => k.id === a.id ? { ...k, premium } : k) });
    this.api.saveXIntegration({ accounts: [{ id: a.id, agents: a.agents, premium }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }

  // ── Listening for mentions ──

  /** The account being checked right now (its button is busy). */
  checking = signal<string | null>(null);
  checked = signal<{ id: string; newTasks: number; newDms: number } | null>(null);

  toggleListen(a: XAccount): void {
    const mentions = !a.listen.mentions;
    const agent = a.listen.agent || a.agents[0] || '';
    if (mentions && !agent) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, listen: { mentions, agent, intervalMinutes: a.listen.intervalMinutes } }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }
  setListenAgent(a: XAccount, event: Event): void {
    const agent = (event.target as HTMLSelectElement).value;
    if (!agent || agent === a.listen.agent) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, listen: { agent } }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }
  toggleDms(a: XAccount): void {
    const dms = !a.listen.dms;
    const agent = a.listen.agent || a.agents[0] || '';
    if (dms && !agent) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, listen: { dms, agent, dmIntervalMinutes: a.listen.dmIntervalMinutes } }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }
  setDmInterval(a: XAccount, event: Event): void {
    const v = Math.round(Number((event.target as HTMLInputElement).value));
    if (!Number.isFinite(v) || v <= 0 || v === a.listen.dmIntervalMinutes) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, listen: { dmIntervalMinutes: v } }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }
  setListenInterval(a: XAccount, event: Event): void {
    const v = Math.round(Number((event.target as HTMLInputElement).value));
    if (!Number.isFinite(v) || v <= 0 || v === a.listen.intervalMinutes) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, listen: { intervalMinutes: v } }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }
  checkNow(a: XAccount): void {
    if (this.checking()) return;
    this.checking.set(a.id);
    this.checked.set(null);
    this.api.checkXMentions(a.id).subscribe({
      next: n => { this.checking.set(null); this.apply(n); if (n.checked) this.checked.set(n.checked); },
      error: e => { this.checking.set(null); this.error.set(this.errorText(e)); },
    });
  }
  /** "3 min", "2 h", "1 d": how long ago the last check was. */
  ago(ts: number | null): string {
    if (!ts) return '';
    const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
    if (m < 60) return `${m} min`;
    if (m < 1440) return `${Math.round(m / 60)} h`;
    return `${Math.round(m / 1440)} d`;
  }

  // ── Money ──

  /** The account's monthly cap, from its field: empty clears it. */
  setCap(a: XAccount, event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim().replace(',', '.');
    const cap = raw === '' ? null : Number(raw);
    if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) return;
    if (cap === (a.monthlyCapUsd ?? null)) return;
    this.api.saveXIntegration({ accounts: [{ id: a.id, monthlyCapUsd: cap }] }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }

  /** The read budget of one task, from its field. */
  setBudget(event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim().replace(',', '.');
    const v = Number(raw);
    if (raw === '' || !(Number.isFinite(v) && v >= 0) || v === this.x()?.taskReadBudgetUsd) return;
    this.api.saveXIntegration({ taskReadBudgetUsd: v }).subscribe({ next: n => { this.apply(n); this.flash(); }, error: e => this.error.set(this.errorText(e)) });
  }

  /** How far into its cap the account is, for the bar (0 to 1; 0 without a cap). */
  capShare(a: XAccount): number {
    return typeof a.monthlyCapUsd === 'number' && a.monthlyCapUsd > 0 ? Math.min(1, a.spentThisMonthUsd / a.monthlyCapUsd) : 0;
  }
  money(n: number | null | undefined): string {
    const v = typeof n === 'number' ? n : 0;
    try { return v.toLocaleString(this.translate.currentLang() || undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 }); } catch { return v.toFixed(2); }
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
    const known = ['bad_client_id', 'no_secret', 'app_not_configured', 'bad_redirect_uri', 'no_redirect_uri', 'state_mismatch', 'no_code', 'scope_missing', 'bad_callback_url', 'no_such_account', 'x_reauth_required', 'scopes_missing'];
    if (known.includes(code)) return this.translate.instant('herramientas.x.errors.' + code);
    return String(e?.error?.message || e?.message || this.translate.instant('herramientas.x.errors.generic'));
  }
}

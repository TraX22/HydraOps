import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, HeldAction, XAccount } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// A sensitive tool call an agent wanted to make on a task that had read outside
// content, or one that always asks (create_skill). It was NOT run: the user approves
// or rejects it here (see the Security page of the manual). The card is rendered
// under the reply that produced it.
//
// x_post gets its own body: the account (with the avatar the card fetched from Tools → X),
// every part as it will be published with its length, the images, the cost. A post goes
// out under the user's name, so the card shows the post, not a JSON dump.
@Component({
  selector: 'app-held-action',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  template: `
    <div class="held" [class.pending]="action.status === 'pending'" [attr.data-status]="action.status">
      <div class="held-head">
        <app-icon name="shield" />
        <span class="held-title">{{ 'chat.held.title' | translate }}</span>
        <code class="held-tool">{{ action.toolName }}</code>
        <span class="held-status">{{ ('chat.held.status.' + action.status) | translate }}</span>
      </div>
      <p class="held-why">{{ (action.origins.length ? 'chat.held.why' : 'chat.held.whyAlways') | translate:{ from: origins } }}</p>
      @if (post; as post) {
        <div class="post">
          <div class="post-account">
            <span class="post-label">{{ 'chat.held.x.account' | translate }}</span>
            @if (xAccount()?.avatar) { <img class="post-avatar" [src]="xAccount()!.avatar" alt="" /> }
            <span class="post-handle">&#64;{{ post.account }}</span>
            @if (xAccount()) { <span class="post-name">{{ xAccount()!.name }}</span> }
            @else if (xChecked()) { <span class="post-warn">{{ 'chat.held.x.unknownAccount' | translate }}</span> }
          </div>
          @if (post.parts.length > 1) { <p class="post-label">{{ 'chat.held.x.parts' | translate:{ n: post.parts.length } }}</p> }
          @for (p of post.parts; track $index) {
            <div class="post-part">
              @if (post.parts.length > 1) { <span class="post-n">{{ $index + 1 }}/</span> }
              <div class="post-body">
                <pre class="post-text">{{ p.text }}</pre>
                <div class="post-meta" [class.bad]="p.chars > charLimit">
                  {{ 'chat.held.x.chars' | translate:{ n: p.chars, max: charLimit } }}@if (p.chars > charLimit) { · {{ 'chat.held.x.tooLong' | translate }} }
                </div>
                @if (p.media.length) {
                  <div class="post-images">
                    @for (m of p.media; track m) {
                      @if (isVideo(m)) { <video [src]="api.storageUrl('uploads/' + m)" [title]="m" controls preload="metadata"></video> }
                      @else { <img [src]="api.storageUrl('uploads/' + m)" [alt]="m" [title]="m" /> }
                    }
                  </div>
                }
              </div>
            </div>
          }
          <p class="post-cost">{{ 'chat.held.x.cost' | translate:{ usd: post.usd } }}@if (post.hasLink) { · {{ 'chat.held.x.linkNote' | translate }} }</p>
        </div>
      } @else if (calendar; as c) {
        <div class="cal">
          <div class="cal-head"><span class="cal-kind">{{ ('chat.held.calendar.' + c.verb) | translate }}</span> <b>{{ c.title }}</b></div>
          @if (c.when) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.when' | translate }}</span>{{ c.when }}</div> }
          @if (c.agent) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.agent' | translate }}</span>{{ c.agent }}</div> }
          @if (c.repeat) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.repeat' | translate }}</span>{{ c.repeat }}</div> }
          @if (c.prompt) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.prompt' | translate }}</span><pre class="cal-pre">{{ c.prompt }}</pre></div> }
          @if (c.notes) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.notes' | translate }}</span><pre class="cal-pre">{{ c.notes }}</pre></div> }
          @if (c.attachments.length) { <div class="cal-row"><span class="cal-label">{{ 'chat.held.calendar.attachments' | translate }}</span>{{ c.attachments.join(', ') }}</div> }
          <p class="cal-note">{{ ('chat.held.calendar.' + (c.verb === 'add' ? 'addNote' : c.verb === 'update' ? 'updateNote' : 'removeNote')) | translate }}</p>
        </div>
      } @else if (argLines.length) {
        <dl class="held-args">
          @for (a of argLines; track a.key) {
            <dt>{{ a.key }}</dt><dd>{{ a.value }}</dd>
          }
        </dl>
      }
      @if (action.status === 'pending') {
        <div class="held-actions">
          <button class="held-approve" [disabled]="busy()" (click)="decide('approve')">
            <app-icon name="check" /> {{ 'chat.held.approve' | translate }}
          </button>
          @if (!post) {
            <button class="held-approve held-approve-task" [disabled]="busy()" (click)="decide('approveTask')" [title]="'chat.held.approveTaskHint' | translate">
              <app-icon name="check" /> {{ 'chat.held.approveTask' | translate }}
            </button>
          }
          <button class="held-reject" [disabled]="busy()" (click)="decide('reject')">
            <app-icon name="x" /> {{ 'chat.held.reject' | translate }}
          </button>
          <span class="held-expires">{{ 'chat.held.expires' | translate:{ when: expiresIn } }}</span>
        </div>
      } @else if (action.result && (action.status === 'executed' || action.status === 'failed')) {
        <details class="held-result" [open]="action.status === 'executed'">
          <summary>{{ 'chat.held.result' | translate }}</summary>
          <pre>{{ action.result }}</pre>
        </details>
      }
      @if (action.scope === 'task' && action.status !== 'pending') { <p class="held-why">{{ 'chat.held.scopeTask' | translate }}</p> }
      @if (error()) { <p class="held-error">{{ error() }}</p> }
    </div>
  `,
  styles: [`
    .held { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--border-color); border-left: 3px solid var(--text-muted); border-radius: 8px; background: var(--bg-surface); font-size: 12.5px; max-width: 560px; }
    .held.pending { border-left-color: #f59e0b; }
    .held[data-status="executed"] { border-left-color: #22c55e; }
    .held[data-status="failed"] { border-left-color: #ef4444; }
    .held-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .held-head app-icon svg { width: 14px; height: 14px; }
    .held-title { font-weight: 600; color: var(--text-primary); }
    .held-tool { font-family: ui-monospace, monospace; font-size: 11.5px; padding: 1px 6px; border-radius: 4px; background: var(--bg-hover, rgba(127,127,127,.15)); }
    .held-status { margin-left: auto; color: var(--text-muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; }
    .held-why { margin: 6px 0 0; color: var(--text-muted); }
    .held-args { margin: 8px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
    .cal { margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
    .cal-head { font-size: 13px; }
    .cal-kind { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin-right: 4px; }
    .cal-row { display: grid; grid-template-columns: 84px 1fr; gap: 8px; align-items: baseline; }
    .cal-label { color: var(--text-muted); font-size: 11px; }
    .cal-pre { margin: 0; white-space: pre-wrap; font: inherit; color: var(--text-secondary); max-height: 140px; overflow: auto; }
    .cal-note { margin: 4px 0 0; font-size: 11.5px; color: var(--text-muted); }
    .held-args dt { color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 11.5px; }
    .held-args dd { margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); }
    .held-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .held-actions button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12.5px; }
    .held-actions button:disabled { opacity: .5; cursor: default; }
    .held-actions button app-icon svg { width: 12px; height: 12px; }
    .held-approve { border-color: #22c55e !important; color: #16a34a !important; }
    .held-approve:hover:not(:disabled) { background: rgba(34,197,94,.12); }
    .held-reject:hover:not(:disabled) { background: rgba(239,68,68,.12); }
    .held-expires { color: var(--text-muted); font-size: 11.5px; margin-left: auto; }
    .held-result { margin-top: 8px; color: var(--text-muted); }
    .held-result summary { cursor: pointer; width: fit-content; }
    .held-result pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11.5px; max-height: 220px; overflow: auto; color: var(--text-primary); }
    .held-error { margin: 6px 0 0; color: #ef4444; }
    .post { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
    .post-account { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .post-label { color: var(--text-muted); font-size: 11.5px; margin: 0; }
    .post-avatar { width: 22px; height: 22px; border-radius: 999px; object-fit: cover; }
    .post-handle { font-weight: 600; color: var(--text-primary); }
    .post-name { color: var(--text-muted); }
    .post-warn { color: #d97706; font-size: 11.5px; }
    .post-part { display: flex; gap: 8px; align-items: flex-start; }
    .post-n { color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 11.5px; padding-top: 7px; min-width: 20px; }
    .post-body { flex: 1; min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 10px; background: var(--bg-hover, rgba(127,127,127,.06)); }
    .post-text { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
    .post-meta { margin-top: 6px; color: var(--text-muted); font-size: 11px; }
    .post-meta.bad { color: #ef4444; font-weight: 600; }
    .post-images { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .post-images img { width: 96px; height: 96px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border-color); }
    .post-images video { max-width: 100%; max-height: 240px; border-radius: 6px; border: 1px solid var(--border-color); background: #000; }
    .post-cost { margin: 0; color: var(--text-muted); font-size: 11.5px; }
  `],
})
export class HeldActionComponent implements OnInit {
  @Input({ required: true }) action!: HeldAction;
  @Output() decided = new EventEmitter<HeldAction>();

  api = inject(ApiService);
  busy = signal(false);
  error = signal('');
  /** For x_post: the connected account the handle names, once Tools → X answered. */
  xAccount = signal<XAccount | null>(null);
  xChecked = signal(false);

  ngOnInit(): void {
    const post = this.post;
    if (!post) return;
    this.api.getXIntegration().subscribe({
      next: x => {
        const a = x.accounts.find(acc => acc.username.toLowerCase() === post.account.toLowerCase());
        this.xAccount.set(a && a.agents.includes(this.action.agentId) && x.enabled ? a : null);
        this.xChecked.set(true);
      },
      error: () => this.xChecked.set(true),
    });
  }

  /** X's length rule for this account: 280 weighted characters, or 25,000 on a Premium account. */
  get charLimit(): number { return this.xAccount()?.premium ? 25_000 : 280; }
  isVideo(name: string): boolean { return /\.mp4$/i.test(name); }

  /** The x_post arguments, read as a post: account, parts with their weighted length and images, cost. */
  get post(): { account: string; parts: { text: string; chars: number; media: string[] }[]; usd: string; hasLink: boolean } | null {
    if (this.action.toolName !== 'x_post') return null;
    const args = (this.action.args ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(args['parts']) ? args['parts'] as Record<string, unknown>[] : [];
    const link = /https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i;
    let usd = 0;
    let hasLink = false;
    const parts = raw.map(p => {
      const text = String(p?.['text'] ?? '');
      const withLink = link.test(text);
      hasLink ||= withLink;
      usd += withLink ? 0.2 : 0.015;
      return {
        text,
        // X's rule: 280 weighted characters, every URL counting as 23.
        chars: text.replace(/https?:\/\/\S+/gi, 'x'.repeat(23)).length,
        media: Array.isArray(p?.['media']) ? (p['media'] as unknown[]).map(String) : [],
      };
    });
    return { account: String(args['account'] ?? '').replace(/^@/, ''), parts, usd: usd.toFixed(3), hasLink };
  }

  /** A calendar_add / calendar_update / calendar_remove call, read as the entry it describes. */
  get calendar(): { verb: 'add' | 'update' | 'remove'; title: string; when: string; agent: string; repeat: string; prompt: string; notes: string; attachments: string[] } | null {
    const m = /^calendar_(add|update|remove)$/.exec(this.action.toolName);
    if (!m) return null;
    const a = (this.action.args ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
    const when = s('date') ? `${s('date')}${s('time') ? ` ${s('time')}` : ''}${s('timezone') ? ` (${s('timezone')})` : ''}` : '';
    const repeat = s('repeat') && s('repeat') !== 'none' ? `${s('repeat')}${s('repeat_until') ? ` → ${s('repeat_until')}` : ''}` : '';
    return {
      verb: m[1] as 'add' | 'update' | 'remove', title: s('title') || s('id'), when, agent: s('agent') || (s('kind') === 'action' ? this.action.agentId : ''), repeat,
      prompt: s('prompt'), notes: s('notes'), attachments: Array.isArray(a['attachments']) ? (a['attachments'] as unknown[]).map(String) : [],
    };
  }

  get origins(): string {
    const list = (this.action.origins ?? []).map(o => o.ref ?? o.tool).slice(0, 3);
    return list.join(', ') || '—';
  }

  get argLines(): { key: string; value: string }[] {
    const args = this.action.args;
    if (!args || typeof args !== 'object') return [];
    return Object.entries(args as Record<string, unknown>).slice(0, 8).map(([key, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      return { key, value: raw.length > 400 ? raw.slice(0, 400) + '…' : raw };
    });
  }

  get expiresIn(): string {
    const ms = new Date(this.action.expiresAt).getTime() - Date.now();
    if (ms <= 0) return '0 min';
    const h = Math.floor(ms / 3_600_000);
    return h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
  }

  decide(what: 'approve' | 'approveTask' | 'reject'): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const call = what === 'reject' ? this.api.rejectHeldAction(this.action.id) : this.api.approveHeldAction(this.action.id, what === 'approveTask' ? 'task' : 'call');
    call.subscribe({
      next: r => { this.busy.set(false); this.action = r.action; this.decided.emit(r.action); },
      error: err => { this.busy.set(false); this.error.set(err?.error?.error || 'error'); this.decided.emit(this.action); },
    });
  }
}

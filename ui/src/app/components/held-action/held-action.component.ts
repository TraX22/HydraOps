import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, HeldAction } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// A sensitive tool call an agent wanted to make on a task that had read outside
// content. It was NOT run: the user approves or rejects it here (see the Security
// page of the manual). The card is rendered under the reply that produced it.
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
      <p class="held-why">{{ 'chat.held.why' | translate:{ from: origins } }}</p>
      @if (argLines.length) {
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
          <button class="held-reject" [disabled]="busy()" (click)="decide('reject')">
            <app-icon name="x" /> {{ 'chat.held.reject' | translate }}
          </button>
          <span class="held-expires">{{ 'chat.held.expires' | translate:{ when: expiresIn } }}</span>
        </div>
      } @else if (action.result && (action.status === 'executed' || action.status === 'failed')) {
        <details class="held-result">
          <summary>{{ 'chat.held.result' | translate }}</summary>
          <pre>{{ action.result }}</pre>
        </details>
      }
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
  `],
})
export class HeldActionComponent {
  @Input({ required: true }) action!: HeldAction;
  @Output() decided = new EventEmitter<HeldAction>();

  private api = inject(ApiService);
  busy = signal(false);
  error = signal('');

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

  decide(what: 'approve' | 'reject'): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const call = what === 'approve' ? this.api.approveHeldAction(this.action.id) : this.api.rejectHeldAction(this.action.id);
    call.subscribe({
      next: r => { this.busy.set(false); this.action = r.action; this.decided.emit(r.action); },
      error: err => { this.busy.set(false); this.error.set(err?.error?.error || 'error'); this.decided.emit(this.action); },
    });
  }
}

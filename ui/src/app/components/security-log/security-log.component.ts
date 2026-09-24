import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, HeldAction, SecurityEvent } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// The prompt-injection log (see the Security page of the manual): which tasks read
// outside content, the sensitive calls made after that, and the held calls with their
// outcome. Read-only; deciding a held call happens in the chat or on Telegram.
@Component({
  selector: 'app-security-log',
  standalone: true,
  imports: [TranslatePipe, IconComponent, DatePipe],
  template: `
    <section class="sec">
      <div class="sec-head">
        <h3><app-icon name="shield" /> {{ 'system.security.title' | translate }}</h3>
        @if (pending() > 0) { <span class="sec-pending">{{ 'system.security.pending' | translate:{ n: pending() } }}</span> }
        <button class="sec-refresh" (click)="load()" [disabled]="loading()">{{ 'system.security.refresh' | translate }}</button>
      </div>
      <p class="sec-hint">{{ 'system.security.hint' | translate }}</p>

      @if (actions().length) {
        <h4>{{ 'system.security.held' | translate }}</h4>
        <table>
          <tbody>
            @for (a of actions(); track a.id) {
              <tr>
                <td class="when">{{ a.createdAt | date:'dd/MM HH:mm' }}</td>
                <td>{{ a.agentId }}</td>
                <td><code>{{ a.toolName }}</code></td>
                <td><span class="st" [attr.data-status]="a.status">{{ ('chat.held.status.' + a.status) | translate }}</span></td>
                <td class="detail" [title]="originText(a)">{{ originText(a) }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      <h4>{{ 'system.security.events' | translate }}</h4>
      @if (!events().length) {
        <p class="sec-empty">{{ 'system.security.empty' | translate }}</p>
      } @else {
        <table>
          <tbody>
            @for (e of events(); track e.id) {
              <tr>
                <td class="when">{{ e.createdAt | date:'dd/MM HH:mm' }}</td>
                <td>{{ e.agentId }}</td>
                <td><span class="ev" [attr.data-type]="e.type">{{ ('system.security.type.' + e.type) | translate }}</span></td>
                <td><code>{{ e.toolName }}</code></td>
                <td class="detail" [title]="e.detail">{{ e.detail }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
  styles: [`
    .sec { margin-top: 24px; overflow-x: auto; padding: 16px 18px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-surface); }
    .sec-head { display: flex; align-items: center; gap: 10px; }
    .sec-head h3 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 15px; color: var(--text-primary); }
    .sec-head h3 app-icon svg { width: 16px; height: 16px; }
    .sec-pending { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(245, 158, 11, .15); color: #b45309; }
    .sec-refresh { margin-left: auto; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12.5px; }
    .sec-hint, .sec-empty { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; }
    h4 { margin: 16px 0 6px; font-size: 13px; color: var(--text-secondary, var(--text-muted)); font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    td { padding: 5px 8px; border-top: 1px solid var(--border-light, var(--border-color)); color: var(--text-primary); vertical-align: top; }
    td.when { white-space: nowrap; color: var(--text-muted); width: 1%; }
    td { white-space: nowrap; }
    /* The detail takes whatever width is left and is cut with an ellipsis (full text on hover). */
    td.detail { color: var(--text-muted); width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; }
    code { font-family: ui-monospace, monospace; font-size: 11.5px; }
    .st, .ev { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--bg-hover, rgba(127,127,127,.15)); white-space: nowrap; }
    .st[data-status="pending"] { background: rgba(245, 158, 11, .15); color: #b45309; }
    .st[data-status="executed"] { background: rgba(34, 197, 94, .15); color: #15803d; }
    .st[data-status="failed"], .st[data-status="rejected"] { background: rgba(239, 68, 68, .12); color: #b91c1c; }
    .ev[data-type="held"] { background: rgba(245, 158, 11, .15); color: #b45309; }
    .ev[data-type="tainted"] { background: rgba(99, 102, 241, .12); color: var(--accent); }
  `],
})
export class SecurityLogComponent implements OnInit {
  private api = inject(ApiService);
  events = signal<SecurityEvent[]>([]);
  actions = signal<HeldAction[]>([]);
  loading = signal(false);
  pending = computed(() => this.actions().filter(a => a.status === 'pending').length);

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.getSecurityEvents(50).subscribe({ next: r => this.events.set(r.events), error: () => {} });
    this.api.getHeldActions().subscribe({
      next: r => { this.actions.set(r.actions.slice(0, 20)); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  originText(a: HeldAction): string {
    return (a.origins ?? []).map(o => o.ref ?? o.tool).slice(0, 2).join(', ');
  }
}

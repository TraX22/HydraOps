import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, Plan, PlanStep } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

export interface PlanVersionRef { version: number; taskId: string; status: Plan['status']; }

// A plan an agent proposed with /plan (see the Chat page of the manual). Pending: the
// user approves it (as is, or edited), discards it, or asks for a revision — the agent
// then answers with the next version, whose steps are marked added / changed / removed.
// Decided plans stay in the chat as a record, with the version chips to look back.
@Component({
  selector: 'app-plan-card',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  template: `
    <div class="plan" [attr.data-status]="plan.status" [class.pending]="plan.status === 'pending'">
      <div class="plan-head">
        <span class="plan-icon">🗺️</span>
        <span class="plan-title">{{ 'chat.plan.title' | translate }}</span>
        <span class="plan-badge" [class.ok]="plan.status === 'approved'">{{ ('chat.plan.status.' + plan.status) | translate }}</span>
        @if (versions.length > 1) {
          <span class="plan-versions">
            @for (v of versions; track v.taskId) {
              <button class="plan-ver" [class.current]="v.taskId === taskId" (click)="jump.emit(v.taskId)" [title]="('chat.plan.status.' + v.status) | translate">v{{ v.version }}</button>
            }
          </span>
        } @else if (plan.version > 1) {
          <span class="plan-ver current">v{{ plan.version }}</span>
        }
      </div>

      @if (plan.goal) { <p class="plan-goal">{{ plan.goal }}</p> }

      @if (mode() === 'edit') {
        <textarea class="plan-edit" [(ngModel)]="draft" rows="10" spellcheck="false"></textarea>
        <p class="plan-hint">{{ 'chat.plan.editHint' | translate }}</p>
        <div class="plan-actions">
          <button class="pbtn primary" [disabled]="busy() || !draft.trim()" (click)="approve(draft)"><app-icon name="play" /> {{ 'chat.plan.approveThis' | translate }}</button>
          <button class="pbtn" [disabled]="busy()" (click)="mode.set('view')">{{ 'common.cancel' | translate }}</button>
        </div>
      } @else if (mode() === 'revise') {
        <textarea class="plan-edit" [(ngModel)]="notes" rows="4" [placeholder]="'chat.plan.revisePlaceholder' | translate"></textarea>
        <p class="plan-hint">{{ 'chat.plan.reviseHint' | translate }}</p>
        <div class="plan-actions">
          <button class="pbtn primary" [disabled]="busy() || !notes.trim()" (click)="sendRevision()"><app-icon name="send" /> {{ 'chat.plan.sendRevision' | translate }}</button>
          <button class="pbtn" [disabled]="busy()" (click)="mode.set('view')">{{ 'common.cancel' | translate }}</button>
        </div>
      } @else {
        <ol class="plan-steps">
          @for (st of plan.steps; track $index) {
            <li [class.removed]="st.change === 'removed'" [class.added]="st.change === 'added'" [class.changed]="st.change === 'changed'">
              <span class="step-n">{{ $index + 1 }}</span>
              <span class="step-body">
                <span class="step-title">{{ st.title }}</span>
                @if (st.detail) { <span class="step-detail">{{ st.detail }}</span> }
                @if (st.change) { <span class="step-change">{{ ('chat.plan.change.' + st.change) | translate }}</span> }
              </span>
              <span class="step-tools">
                @if (st.agent) { <span class="tool who">🤝 {{ st.agent }}</span> }
                @for (t of st.tools ?? []; track t) { <span class="tool" [class.act]="isActing(t)">{{ toolLabel(t) }}</span> }
              </span>
            </li>
          }
        </ol>
        @if (plan.implications) {
          <div class="plan-box impl"><b>↳ {{ 'chat.plan.implications' | translate }}:</b> {{ plan.implications }}</div>
        }
        @if (plan.questions.length) {
          <div class="plan-box ask">
            <b>❓ {{ 'chat.plan.questions' | translate }}</b>
            <ul>@for (q of plan.questions; track q) { <li>{{ q }}</li> }</ul>
          </div>
        }
        @if (plan.status === 'pending') {
          <div class="plan-actions">
            <button class="pbtn primary" [disabled]="busy()" (click)="approve()"><app-icon name="play" /> {{ 'chat.plan.approve' | translate }}</button>
            <button class="pbtn" [disabled]="busy()" (click)="startEdit()"><app-icon name="pencil" /> {{ 'chat.plan.edit' | translate }}</button>
            <button class="pbtn" [disabled]="busy()" (click)="mode.set('revise')"><app-icon name="sparkles" /> {{ 'chat.plan.revise' | translate }}</button>
            <button class="pbtn danger" [disabled]="busy()" (click)="discard()"><app-icon name="x" /> {{ 'chat.plan.discard' | translate }}</button>
          </div>
        } @else if (plan.status === 'approved' && plan.approvedText) {
          <details class="plan-approved-text"><summary>{{ 'chat.plan.approvedTextLabel' | translate }}</summary><pre>{{ plan.approvedText }}</pre></details>
        }
      }
      @if (error()) { <p class="plan-error">{{ error() }}</p> }
    </div>
  `,
  styles: [`
    .plan { margin-top: 8px; padding: 10px 12px 12px; border: 1px solid var(--border-color); border-left: 3px solid var(--text-muted); border-radius: 10px; background: var(--bg-surface); font-size: 13px; max-width: 640px; }
    .plan.pending { border-left-color: var(--accent); }
    .plan[data-status="approved"] { border-left-color: #22c55e; }
    .plan[data-status="discarded"] { opacity: .75; }
    .plan-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .plan-title { font-weight: 700; color: var(--text-primary); }
    .plan-badge { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
    .plan-badge.ok { background: rgba(34,197,94,.14); color: #16a34a; }
    .plan-versions { margin-left: auto; display: inline-flex; gap: 4px; }
    .plan-ver { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-color); background: transparent; color: var(--text-secondary); cursor: pointer; }
    .plan-ver.current { border-color: var(--accent); color: var(--accent); font-weight: 600; cursor: default; }
    .plan-goal { margin: 6px 0 10px; color: var(--text-secondary); line-height: 1.45; }
    .plan-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .plan-steps li { display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; align-items: start; line-height: 1.4; }
    .step-n { width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
    .step-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .step-detail { color: var(--text-muted); font-size: 12px; }
    .step-change { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    li.added .step-title { color: #16a34a; } li.added .step-change { color: #16a34a; } li.added .step-n { background: rgba(34,197,94,.16); color: #16a34a; }
    li.changed .step-title { color: var(--accent); } li.changed .step-change { color: var(--accent); }
    li.removed .step-title { text-decoration: line-through; color: var(--text-muted); } li.removed .step-change { color: #ef4444; } li.removed .step-n { background: rgba(239,68,68,.12); color: #ef4444; }
    .step-tools { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 220px; }
    .tool { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-color); color: var(--text-secondary); white-space: nowrap; }
    .tool.act { border-color: color-mix(in srgb, #d97706 45%, var(--border-color)); color: #d97706; }
    .tool.who { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color)); color: var(--accent); }
    .plan-box { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.45; color: var(--text-primary); }
    .plan-box.ask { background: color-mix(in srgb, var(--accent) 7%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
    .plan-box.impl { background: color-mix(in srgb, #d97706 8%, transparent); border: 1px solid color-mix(in srgb, #d97706 30%, transparent); }
    .plan-box ul { margin: 4px 0 0; padding-left: 18px; }
    .plan-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .pbtn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 7px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); font-size: 12.5px; cursor: pointer; }
    .pbtn:disabled { opacity: .5; cursor: default; }
    .pbtn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .pbtn.danger:hover:not(:disabled) { color: #ef4444; border-color: rgba(239,68,68,.45); }
    .pbtn app-icon svg { width: 12px; height: 12px; }
    .plan-edit { width: 100%; box-sizing: border-box; margin-top: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; padding: 10px; border-radius: 8px; border: 1px solid var(--accent); background: var(--bg-surface-alt, var(--bg-hover)); color: var(--text-primary); resize: vertical; }
    .plan-hint { margin: 6px 0 0; font-size: 11.5px; color: var(--text-muted); }
    .plan-approved-text { margin-top: 8px; color: var(--text-muted); font-size: 12px; }
    .plan-approved-text summary { cursor: pointer; width: fit-content; }
    .plan-approved-text pre { margin: 6px 0 0; white-space: pre-wrap; font-size: 11.5px; color: var(--text-primary); }
    .plan-error { margin: 6px 0 0; color: #ef4444; font-size: 12px; }
  `],
})
export class PlanCardComponent {
  @Input({ required: true }) plan!: Plan;
  @Input({ required: true }) taskId!: string;
  @Input() versions: PlanVersionRef[] = [];
  /** After approve / discard: the parent reloads the history. */
  @Output() decided = new EventEmitter<void>();
  /** The user's notes for a revision: the parent sends them as a plan-mode task. */
  @Output() revise = new EventEmitter<string>();
  /** A version chip: scroll to that version's message. */
  @Output() jump = new EventEmitter<string>();

  private api = inject(ApiService);
  private t = inject(TranslateService);
  mode = signal<'view' | 'edit' | 'revise'>('view');
  busy = signal(false);
  error = signal('');
  draft = '';
  notes = '';

  private static readonly ACTING = /^(send_to_telegram|remember|create_skill|delegate_task|generate_image|generate_video|github_(create|comment)|github_api)/i;
  isActing(tool: string): boolean { return PlanCardComponent.ACTING.test(tool); }
  toolLabel(tool: string): string {
    const t = tool.toLowerCase();
    if (t.includes('search')) return '🔎 ' + tool;
    if (t === 'fetch_url') return '📄 ' + tool;
    if (t === 'generate_image') return '🎨 ' + tool;
    if (t === 'generate_video') return '🎬 ' + tool;
    if (t === 'skills_view') return '🧩 skill';
    if (t === 'send_to_telegram') return '📨 ' + tool;
    return tool;
  }

  startEdit(): void { this.draft = this.renderText(this.plan); this.mode.set('edit'); }

  /** The plan as text, as the user edits it (kept in step with renderPlanText in @hydraops/addons). */
  private renderText(plan: Plan): string {
    const lines: string[] = [];
    if (plan.goal) lines.push(`Goal: ${plan.goal}`, '');
    plan.steps.forEach((st: PlanStep, i: number) => {
      if (st.change === 'removed') return;
      const extras: string[] = [];
      if (st.agent) extras.push(`→ ${st.agent}`);
      if (st.tools?.length) extras.push(st.tools.join(', '));
      lines.push(`${i + 1}. ${st.title}${extras.length ? ` (${extras.join(' · ')})` : ''}`);
      if (st.detail) lines.push(`   ${st.detail}`);
    });
    if (plan.questions.length) { lines.push('', 'Open questions:'); for (const q of plan.questions) lines.push(`- ${q}`); }
    return lines.join('\n').trim();
  }

  approve(text?: string): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.api.approvePlan(this.taskId, text).subscribe({
      next: r => { this.busy.set(false); this.plan = r.plan; this.mode.set('view'); this.decided.emit(); },
      error: err => { this.busy.set(false); this.error.set(err?.error?.error === 'already_decided' ? this.t.instant('chat.plan.alreadyDecided') : (err?.error?.error || 'error')); },
    });
  }

  discard(): void {
    if (this.busy() || !confirm(this.t.instant('chat.plan.discardConfirm'))) return;
    this.busy.set(true); this.error.set('');
    this.api.discardPlan(this.taskId).subscribe({
      next: r => { this.busy.set(false); this.plan = r.plan; this.decided.emit(); },
      error: err => { this.busy.set(false); this.error.set(err?.error?.error || 'error'); },
    });
  }

  sendRevision(): void {
    const text = this.notes.trim();
    if (!text || this.busy()) return;
    this.revise.emit(text);
    this.notes = '';
    this.mode.set('view');
  }
}

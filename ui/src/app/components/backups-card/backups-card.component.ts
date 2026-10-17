import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, BackupEntry, BackupsInfo, RestoreState } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// Copies of the installation (System view): make one, put one back, delete one. A copy is
// a folder under the data folder's backups/; one is made on its own before every update.
// Putting a copy back goes through the supervisor: the stack stops, the current state is
// kept as a copy too, the files are replaced and the app relaunches.
@Component({
  selector: 'app-backups-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent, DatePipe],
  template: `
    <section class="sec">
      <div class="sec-head">
        <h3><app-icon name="storage" /> {{ 'system.backups.title' | translate }}</h3>
        <button class="sec-refresh" (click)="load()" [disabled]="loading()">{{ 'system.backups.refresh' | translate }}</button>
      </div>
      <p class="sec-hint">{{ 'system.backups.hint' | translate }}</p>

      @if (restoring()) {
        <p class="bk-status working"><app-icon name="hourglass" /> {{ 'system.backups.restoring' | translate }}</p>
      } @else if (restoreDone()) {
        <p class="bk-status done"><app-icon name="check" /> {{ 'system.backups.restored' | translate:{ name: restoreDone() } }}</p>
      }
      @if (error()) {
        <p class="bk-status error"><app-icon name="alert" /> {{ error() }}</p>
      }

      <div class="bk-make">
        <label><input type="checkbox" [checked]="withStorage()" (change)="withStorage.set($any($event.target).checked)" /> {{ 'system.backups.withStorage' | translate }}</label>
        <label><input type="checkbox" [checked]="withKeys()" (change)="withKeys.set($any($event.target).checked)" /> {{ 'system.backups.withKeys' | translate }}</label>
        <button class="bk-btn primary" (click)="make()" [disabled]="making() || restoring()">
          @if (making()) { {{ 'system.backups.making' | translate }} } @else { {{ 'system.backups.make' | translate }} }
        </button>
      </div>

      @if (!backups().length) {
        <p class="sec-empty">{{ 'system.backups.empty' | translate }}</p>
      } @else {
        <table>
          <tbody>
            @for (b of backups(); track b.name) {
              <tr>
                <td class="when">{{ b.at | date:'dd/MM/yyyy HH:mm' }}</td>
                <td><span class="kind" [attr.data-kind]="b.kind">{{ ('system.backups.kind.' + b.kind) | translate }}</span></td>
                <td class="detail" [title]="b.name">v{{ b.version }}@if (b.label) { · {{ b.label }} }@if (b.storage) { · {{ 'system.backups.hasStorage' | translate }} }@if (b.keys) { · {{ 'system.backups.hasKeys' | translate }} }@if (b.legacy) { · {{ 'system.backups.inDataFolder' | translate }} }</td>
                <td class="size">{{ size(b.size) }}</td>
                <td class="actions">
                  <button class="bk-btn" (click)="restore(b)" [disabled]="restoring() || making()">{{ 'system.backups.restore' | translate }}</button>
                  <button class="bk-btn danger" (click)="remove(b)" [disabled]="restoring()" [title]="'common.delete' | translate"><app-icon name="trash" /></button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
      @if (lastRestore(); as last) {
        <p class="bk-dir">{{ 'system.backups.lastRestore' | translate:{ name: last.name, date: (last.at | date:'dd/MM/yyyy HH:mm') } }}</p>
      }
      @if (info()?.dir) {
        <p class="bk-dir">{{ 'system.backups.folder' | translate }} <code>{{ info()!.dir }}</code></p>
      }
    </section>
  `,
  styles: [`
    .sec { margin-top: 24px; overflow-x: auto; padding: 16px 18px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-surface); }
    .sec-head { display: flex; align-items: center; gap: 10px; }
    .sec-head h3 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 15px; color: var(--text-primary); }
    .sec-head h3 app-icon svg { width: 16px; height: 16px; }
    .sec-refresh { margin-left: auto; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12.5px; }
    .sec-hint, .sec-empty, .bk-dir { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; }
    .bk-dir code { font-family: ui-monospace, monospace; font-size: 11.5px; }
    .bk-make { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 14px 0 10px; font-size: 12.5px; color: var(--text-primary); }
    .bk-make label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .bk-btn { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; }
    .bk-btn app-icon svg { width: 13px; height: 13px; }
    .bk-btn.primary { margin-left: auto; background: var(--accent); border-color: var(--accent); color: #fff; }
    .bk-btn.danger:hover { color: #b91c1c; border-color: #b91c1c; }
    .bk-btn:disabled { opacity: .55; cursor: default; }
    .bk-status { margin: 10px 0 0; font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }
    .bk-status app-icon svg { width: 14px; height: 14px; }
    .bk-status.working { color: #b45309; }
    .bk-status.done { color: #15803d; }
    .bk-status.error { color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    td { padding: 5px 8px; border-top: 1px solid var(--border-light, var(--border-color)); color: var(--text-primary); vertical-align: middle; white-space: nowrap; }
    td.when { color: var(--text-muted); width: 1%; }
    td.detail { color: var(--text-muted); width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; }
    td.size { color: var(--text-muted); text-align: right; }
    td.actions { display: flex; gap: 6px; justify-content: flex-end; }
    .kind { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--bg-hover, rgba(127,127,127,.15)); white-space: nowrap; }
    .kind[data-kind="before-update"] { background: rgba(59, 130, 246, .15); color: #1d4ed8; }
    .kind[data-kind="before-restore"] { background: rgba(245, 158, 11, .15); color: #b45309; }
  `],
})
export class BackupsCardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private translate = inject(TranslateService);

  info = signal<BackupsInfo | null>(null);
  backups = signal<BackupEntry[]>([]);
  loading = signal(false);
  making = signal(false);
  restoring = signal(false);
  restoreDone = signal('');
  lastRestore = signal<{ name: string; at: number } | null>(null);
  error = signal('');
  withStorage = signal(false);
  withKeys = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStarted = 0;

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void { if (this.pollTimer) clearInterval(this.pollTimer); }

  load(): void {
    this.loading.set(true);
    this.api.getBackups().subscribe({
      next: (i) => {
        this.info.set(i);
        this.backups.set(i.backups);
        this.loading.set(false);
        // The last restore, done while the app relaunched: one quiet line, or its error.
        const r = i.restore;
        this.lastRestore.set(r?.status === 'success' && r.name ? { name: r.name, at: Number(r.finishedAt) || Date.now() } : null);
        if (r?.status === 'error' && r.error && !this.restoring()) this.error.set(this.translate.instant('system.backups.failed', { error: r.error }));
      },
      error: () => this.loading.set(false),
    });
  }

  make(): void {
    this.error.set('');
    this.making.set(true);
    this.api.createBackup({ storage: this.withStorage(), keys: this.withKeys() }).subscribe({
      next: () => { this.making.set(false); this.load(); },
      error: (e) => { this.making.set(false); this.error.set(e?.error?.message || this.translate.instant('system.backups.failed', { error: '' })); },
    });
  }

  remove(b: BackupEntry): void {
    if (!confirm(this.translate.instant('system.backups.deleteConfirm', { name: b.name }))) return;
    this.api.deleteBackup(b.name).subscribe({ next: () => this.load(), error: (e) => this.error.set(e?.error?.message || 'error') });
  }

  restore(b: BackupEntry): void {
    if (!confirm(this.translate.instant('system.backups.restoreConfirm', { name: b.name, version: b.version }))) return;
    this.error.set('');
    this.restoreDone.set('');
    this.restoring.set(true);
    this.api.restoreBackup(b.name).subscribe({
      next: () => this.beginPolling(),
      error: (e) => { this.restoring.set(false); this.error.set(e?.error?.message || this.translate.instant('system.backups.failed', { error: '' })); },
    });
  }

  // The stack stops and the app relaunches: the API is away for a while, so a network
  // error means "still restarting", and only a state read back decides.
  private beginPolling(): void {
    this.pollStarted = Date.now();
    this.pollTimer = setInterval(() => {
      if (Date.now() - this.pollStarted > 5 * 60 * 1000) { this.finish(null); return; }
      this.api.restoreStatus().subscribe({
        next: (s) => { if (s.status === 'success' || s.status === 'error') this.finish(s); },
        error: () => {},
      });
    }, 2500);
  }

  private finish(s: RestoreState | null): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.restoring.set(false);
    if (!s) { this.error.set(this.translate.instant('system.backups.tooLong')); return; }
    if (s.status === 'success') {
      this.restoreDone.set(s.name ?? '');
      setTimeout(() => window.location.reload(), 2500);
    } else {
      this.error.set(this.translate.instant('system.backups.failed', { error: s.error ?? '' }));
    }
    this.load();
  }

  size(n: number): string {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
}

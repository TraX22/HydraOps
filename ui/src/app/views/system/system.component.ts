import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, SelfUpdateStatus, VersionInfo, Worker } from '../../services/api.service';

@Component({
  selector: 'app-system',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './system.component.html',
  styleUrl: './system.component.css',
})
export class SystemComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);

  workers = signal<Worker[]>([]);
  loading = signal(false);
  showLogsModal = signal(false);
  selectedWorkerId = signal('');
  logs = signal('');

  // ── Self-update (instalación desde código) ──
  version = signal<VersionInfo | null>(null);
  updating = signal(false);
  updateState = signal<SelfUpdateStatus | null>(null);
  updateError = signal('');
  updateDone = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStarted = 0;

  ngOnInit(): void {
    this.fetch();
    this.api.getVersion().subscribe(v => this.version.set(v));
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  fetch(): void {
    this.loading.set(true);
    this.api.getWorkers().subscribe({ next: w => { this.workers.set(w); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  startUpdate(): void {
    this.updateError.set('');
    this.updateDone.set(false);
    this.updateState.set(null);
    this.updating.set(true);
    this.api.selfUpdate().subscribe({
      next: () => this.beginPolling(),
      error: (e) => {
        this.updating.set(false);
        this.updateError.set(e?.error?.message || 'No se pudo iniciar la actualización.');
      },
    });
  }

  private beginPolling(): void {
    this.pollStarted = Date.now();
    this.pollTimer = setInterval(() => {
      // Tope de seguridad: si tras 8 min no terminó, deja de esperar.
      if (Date.now() - this.pollStarted > 8 * 60 * 1000) {
        this.finish(false, 'La actualización está tardando demasiado. Revisa los logs del servidor.');
        return;
      }
      this.api.selfUpdateStatus().subscribe({
        next: (s) => {
          this.updateState.set(s);
          if (s.status === 'success') this.finish(true);
          else if (s.status === 'error') this.finish(false, s.error);
          // queued/running/restarting → seguir sondeando
        },
        // Error de red = la API se está reiniciando: seguir intentando, ya volverá.
        error: () => {},
      });
    }, 2500);
  }

  private finish(ok: boolean, error?: string): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.updating.set(false);
    if (ok) {
      this.updateDone.set(true);
      // La UI puede ser nueva: recargar para tomar el build actualizado.
      setTimeout(() => window.location.reload(), 2500);
    } else {
      this.updateError.set(error || 'La actualización falló. Revisa los logs.');
    }
  }

  viewLogs(worker: Worker): void {
    this.selectedWorkerId.set(worker.id);
    this.showLogsModal.set(true);
    this.api.getWorkerLogs(worker.id).subscribe(l => this.logs.set(l));
  }

  statusColor(status: string): string {
    return status === 'online' ? 'var(--status-online)' : 'var(--status-offline)';
  }
}

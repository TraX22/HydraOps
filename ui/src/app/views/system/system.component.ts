import { Component, inject, OnInit, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, VersionInfo, Worker } from '../../services/api.service';
import { IconComponent } from '../../components/icon/icon.component';
import { SecurityLogComponent } from '../../components/security-log/security-log.component';
import { BackupsCardComponent } from '../../components/backups-card/backups-card.component';
import { UpdateService } from '../../services/update.service';

@Component({
  selector: 'app-system',
  standalone: true,
  imports: [TranslatePipe, IconComponent, SecurityLogComponent, BackupsCardComponent],
  templateUrl: './system.component.html',
  styleUrl: './system.component.css',
})
export class SystemComponent implements OnInit {
  private api = inject(ApiService);
  /** The update runs from the sidebar; this view shows its log. */
  updates = inject(UpdateService);

  workers = signal<Worker[]>([]);
  loading = signal(false);
  showLogsModal = signal(false);
  selectedWorkerId = signal('');
  logs = signal('');

  version = signal<VersionInfo | null>(null);

  ngOnInit(): void {
    this.fetch();
    this.api.getVersion().subscribe(v => this.version.set(v));
  }

  fetch(): void {
    this.loading.set(true);
    this.api.getWorkers().subscribe({ next: w => { this.workers.set(w); this.loading.set(false); }, error: () => this.loading.set(false) });
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

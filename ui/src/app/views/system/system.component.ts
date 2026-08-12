import { Component, inject, OnInit, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, Worker } from '../../services/api.service';

@Component({
  selector: 'app-system',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './system.component.html',
  styleUrl: './system.component.css',
})
export class SystemComponent implements OnInit {
  private api = inject(ApiService);

  workers = signal<Worker[]>([]);
  loading = signal(false);
  showLogsModal = signal(false);
  selectedWorkerId = signal('');
  logs = signal('');

  ngOnInit(): void {
    this.fetch();
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

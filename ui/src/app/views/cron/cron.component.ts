import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, CronJob, Agent } from '../../services/api.service';

interface CronAlias {
  labelKey: string;
  value: string;
}

@Component({
  selector: 'app-cron',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './cron.component.html',
  styleUrl: './cron.component.css',
})
export class CronComponent implements OnInit {
  private api = inject(ApiService);
  private translate = inject(TranslateService);
  crons = signal<CronJob[]>([]);
  agents = signal<Agent[]>([]);
  loading = signal(false);
  showForm = signal(false);
  showEditModal = signal(false);
  editingCron = signal<Partial<CronJob>>({});

  name = '';
  taskPrompt = '';
  assignedAgent = '';
  cronExpression = '';

  aliases: CronAlias[] = [
    { labelKey: 'cron.every1min', value: '* * * * *' },
    { labelKey: 'cron.every5min', value: '*/5 * * * *' },
    { labelKey: 'cron.every30min', value: '*/30 * * * *' },
    { labelKey: 'cron.hourly', value: '0 * * * *' },
    { labelKey: 'cron.noon', value: '0 12 * * *' },
    { labelKey: 'cron.midnight', value: '0 0 * * *' },
    { labelKey: 'cron.workHours', value: '0 9-17 * * 1-5' },
  ];

  ngOnInit(): void {
    this.fetch();
  }

  fetch(): void {
    this.loading.set(true);
    this.api.getCrons().subscribe(c => { this.crons.set(c); this.loading.set(false); });
    this.api.getAgents().subscribe(a => this.agents.set(a));
  }

  create(): void {
    if (!this.name || !this.taskPrompt || !this.cronExpression) return;
    this.api.createCron({
      name: this.name, prompt: this.taskPrompt,
      cronExpression: this.cronExpression, assignedAgent: this.assignedAgent,
    }).subscribe(() => { this.resetForm(); this.fetch(); });
  }

  toggle(id: string): void {
    this.api.toggleCron(id).subscribe(() => this.fetch());
  }

  delete(cron: CronJob): void {
    const answer = prompt(this.translate.instant('cron.deleteConfirm', { name: cron.name }));
    if (answer === cron.name) {
      this.api.deleteCron(cron.id).subscribe(() => this.fetch());
    }
  }

  openEdit(cron: CronJob): void {
    this.editingCron.set({ ...cron });
    this.showEditModal.set(true);
  }

  saveEdit(): void {
    const c = this.editingCron();
    if (c.id) {
      this.api.updateCron(c.id, c).subscribe(() => { this.showEditModal.set(false); this.fetch(); });
    }
  }

  private resetForm(): void {
    this.name = ''; this.taskPrompt = ''; this.assignedAgent = ''; this.cronExpression = '';
    this.showForm.set(false);
  }
}

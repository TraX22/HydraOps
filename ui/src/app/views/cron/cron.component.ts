import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, CronJob, Agent } from '../../services/api.service';
import { IconComponent } from '../../components/icon/icon.component';

interface CronAlias {
  labelKey: string;
  value: string;
}

@Component({
  selector: 'app-cron',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
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
    this.api.getAgents().subscribe(a => {
      this.agents.set(a);
      // A cron always runs on a concrete agent (no smart routing): default the
      // form to the first one in the list.
      if (!this.assignedAgent && a.length) this.assignedAgent = a[0].id;
    });
  }

  // Map an agent id to its display name for the cron cards.
  agentName(id?: string | null): string {
    if (!id) return this.agents()[0]?.name ?? '—';
    return this.agents().find(a => a.id === id)?.name ?? id;
  }

  create(): void {
    if (!this.name || !this.taskPrompt || !this.cronExpression) return;
    const agent = this.assignedAgent || this.agents()[0]?.id || '';
    this.api.createCron({
      name: this.name, prompt: this.taskPrompt,
      cronExpression: this.cronExpression, assignedAgent: agent,
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
    // Legacy crons may have no agent (old "smart routing"); normalize to the
    // first agent so the select always shows a concrete choice.
    this.editingCron.set({ ...cron, assignedAgent: cron.assignedAgent ?? this.agents()[0]?.id ?? null });
    this.showEditModal.set(true);
  }

  saveEdit(): void {
    const c = this.editingCron();
    if (c.id) {
      this.api.updateCron(c.id, c).subscribe(() => { this.showEditModal.set(false); this.fetch(); });
    }
  }

  private resetForm(): void {
    this.name = ''; this.taskPrompt = ''; this.assignedAgent = this.agents()[0]?.id ?? ''; this.cronExpression = '';
    this.showForm.set(false);
  }
}

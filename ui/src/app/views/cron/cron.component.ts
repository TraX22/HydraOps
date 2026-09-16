import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, CronJob, Agent } from '../../services/api.service';
import { IconComponent } from '../../components/icon/icon.component';
import { CronScheduleComponent } from '../../components/cron-schedule/cron-schedule.component';

@Component({
  selector: 'app-cron',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent, CronScheduleComponent],
  templateUrl: './cron.component.html',
  styleUrl: './cron.component.css',
})
export class CronComponent implements OnInit {
  private api = inject(ApiService);
  private translate = inject(TranslateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
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

  ngOnInit(): void {
    this.fetch();
    // The /cron command lands here with the form pre-filled for confirmation.
    const q = this.route.snapshot.queryParamMap;
    if (q.get('prompt') && q.get('cronExpression')) {
      this.name = q.get('name') ?? '';
      this.taskPrompt = q.get('prompt') ?? '';
      this.cronExpression = q.get('cronExpression') ?? '';
      if (q.get('assignedAgent')) this.assignedAgent = q.get('assignedAgent')!;
      this.showForm.set(true);
      this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    }
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

import { Component, DestroyRef, computed, inject, resource } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, StatsData } from '../../services/api.service';
import { IconComponent } from '../../components/icon/icon.component';

interface MetricCard {
  labelKey: string;
  value: string;
  sub?: string;
  icon: string;
}

const REFRESH_MS = 10_000;

@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './stats.component.html',
  styleUrl: './stats.component.css',
})
export class StatsComponent {
  private api = inject(ApiService);

  statsResource = resource({
    loader: (): Promise<StatsData> => firstValueFrom(this.api.getStats()),
  });

  constructor() {
    const timer = setInterval(() => this.statsResource.reload(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  stats = computed(() => (this.statsResource.hasValue() ? this.statsResource.value() : null));

  metrics = computed<MetricCard[]>(() => {
    const s = this.stats();
    if (!s) return [];
    return [
      {
        labelKey: 'stats.completedTasks',
        value: `${s.tasks.completed}`,
        sub: `/ ${s.tasks.total}`,
        icon: 'check',
      },
      { labelKey: 'stats.failedTasks', value: `${s.tasks.failed}`, icon: 'failed' },
      { labelKey: 'stats.responseTime', value: this.formatMs(s.avgResponseMs), icon: 'zap' },
      { labelKey: 'stats.totalTokens', value: this.formatCount(s.totalTokens), icon: 'ticket' },
      { labelKey: 'stats.messages', value: `${s.tasks.total}`, icon: 'mail' },
      {
        labelKey: 'stats.activeAgents',
        value: `${s.activeAgents} / ${s.totalAgents}`,
        icon: 'agents',
      },
      { labelKey: 'stats.cpu', value: `${s.system.cpuPercent}%`, icon: 'monitor' },
      {
        labelKey: 'stats.ram',
        value: `${s.system.ramPercent}%`,
        sub: `${this.formatGb(s.system.ramUsedBytes)} / ${this.formatGb(s.system.ramTotalBytes)} GB`,
        icon: 'storage',
      },
    ];
  });

  formatMs(ms: number): string {
    if (!ms) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
  }

  formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }

  formatGb(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
  }
}

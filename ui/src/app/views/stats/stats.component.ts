import { Component, DestroyRef, computed, inject, resource } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, StatsData, ToolUsageReport } from '../../services/api.service';
import { AgentsService } from '../../services/agents.service';
import { IconComponent } from '../../components/icon/icon.component';

interface MetricCard {
  labelKey: string;
  value: string;
  sub?: string;
  icon: string;
}

// One FUT-style attribute on an agent card (0-99 rating + real value tooltip).
interface CardAttr {
  labelKey: string; // i18n key for the full stat name (Speed, Tasks…)
  value: number;    // 0-99 rating
  title: string;    // tooltip with the real underlying stat
}

interface AgentCard {
  agentId: string;
  name: string;
  avatarUrl?: string;
  initial: string;
  online: boolean;
  position: string;             // role abbreviation (DEV/GEN/ART/VID)
  ovr: number;                  // 0-99 overall
  tier: 'gold' | 'platinum' | 'bronze';
  attrs: CardAttr[];
}

const REFRESH_MS = 10_000;

// Worker role → FUT-style position label.
const POSITION_BY_ROLE: Record<string, string> = {
  coder: 'DEV', general: 'GEN', graphic: 'ART', video: 'VID',
};

@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './stats.component.html',
  styleUrl: './stats.component.css',
})
export class StatsComponent {
  private api = inject(ApiService);
  private agentsService = inject(AgentsService);
  private t = inject(TranslateService);

  statsResource = resource({
    loader: (): Promise<StatsData> => firstValueFrom(this.api.getStats()),
  });

  // Tool usage over the last 7 days (which tools/add-ons/MCP agents actually use).
  toolUsageResource = resource({
    loader: (): Promise<ToolUsageReport> => firstValueFrom(this.api.getToolUsage(7)),
  });

  constructor() {
    const timer = setInterval(() => {
      this.statsResource.reload();
      this.toolUsageResource.reload();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  stats = computed(() => (this.statsResource.hasValue() ? this.statsResource.value() : null));
  toolUsage = computed(() => (this.toolUsageResource.hasValue() ? this.toolUsageResource.value() : null));

  // Per-agent usage rows enriched with the agent's display name.
  toolByAgent = computed(() => {
    const u = this.toolUsage();
    if (!u) return [];
    const agents = this.agentsService.agents();
    return u.byAgent.map(a => ({
      ...a,
      name: agents.find(g => g.id === a.agentId)?.name ?? a.agentId,
    }));
  });

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

  // FUT-style cards for the per-agent stats. Each of the six attributes is a
  // 0-99 rating derived from a real column; counts are scaled relative to the
  // busiest agent so the numbers land in a football-card range, while rate-based
  // ones (success, avoiding failures) are absolute percentages. Tooltips carry
  // the real underlying value so nothing is lost to the flavour.
  agentCards = computed<AgentCard[]>(() => {
    const s = this.stats();
    if (!s || s.perAgent.length === 0) return [];
    const agents = this.agentsService.agents();

    const maxTotal = Math.max(1, ...s.perAgent.map(a => a.total));
    const maxTokens = Math.max(1, ...s.perAgent.map(a => a.tokens));
    const maxCompleted = Math.max(1, ...s.perAgent.map(a => a.completed));
    const positiveMs = s.perAgent.map(a => a.avgMs).filter(ms => ms > 0);
    const minMs = positiveMs.length ? Math.min(...positiveMs) : 0;

    // 0 → 40, max → 99 (avoids the ugly sub-40 numbers a real FUT card never shows).
    const scale = (v: number, max: number) => this.clamp99(Math.round(40 + 59 * (v / max)));
    const rateScore = (r: number) => this.clamp99(Math.round(40 + 59 * Math.max(0, Math.min(1, r))));

    const label = (key: string) => this.t.instant(key);

    return s.perAgent.map(a => {
      const meta = agents.find(g => g.id === a.agentId);
      const successRate = a.total > 0 ? a.completed / a.total : 0;
      const failRate = a.total > 0 ? a.failed / a.total : 0;
      const pace = minMs > 0 && a.avgMs > 0 ? this.clamp99(Math.round(40 + 59 * (minMs / a.avgMs))) : 40;
      const pct = Math.round(successRate * 100);

      const attrs: CardAttr[] = [
        { labelKey: 'stats.attrSpeed', value: pace, title: `${label('stats.avgTime')}: ${this.formatMs(a.avgMs)}` },
        { labelKey: 'stats.attrCompleted', value: scale(a.completed, maxCompleted), title: `${label('stats.completed')}: ${a.completed}` },
        { labelKey: 'stats.attrTasks', value: scale(a.total, maxTotal), title: `${label('stats.tasks')}: ${a.total}` },
        { labelKey: 'stats.attrSuccess', value: rateScore(successRate), title: `${label('stats.completed')} / ${label('stats.tasks')}: ${pct}%` },
        { labelKey: 'stats.attrReliability', value: rateScore(1 - failRate), title: `${label('stats.failed')}: ${a.failed}` },
        { labelKey: 'stats.attrLoad', value: scale(a.tokens, maxTokens), title: `${label('stats.tokens')}: ${this.formatCount(a.tokens)}` },
      ];

      // OVR leans on output and reliability, like a striker's rating.
      const ovr = Math.round(
        (attrs[1].value * 1.5 + attrs[3].value * 1.3 + attrs[4].value * 1.2 +
          attrs[0].value + attrs[2].value + attrs[5].value) / 7.0,
      );
      const name = meta?.name ?? a.agentId;
      const role = (meta?.workerType ?? '').toLowerCase();

      return {
        agentId: a.agentId,
        name,
        avatarUrl: meta?.avatarUrl,
        initial: (name[0] ?? 'A').toUpperCase(),
        online: a.online,
        position: POSITION_BY_ROLE[role] ?? (role ? role.slice(0, 3).toUpperCase() : 'AGT'),
        ovr,
        tier: 'bronze' as AgentCard['tier'], // set by rank below
        attrs,
      };
    })
      .sort((a, b) => b.ovr - a.ovr)
      // Tier by ranking: 1st → gold, 2nd/3rd → platinum, the rest → bronze.
      .map((card, i) => ({ ...card, tier: i === 0 ? 'gold' : i <= 2 ? 'platinum' : 'bronze' } as AgentCard));
  });

  private clamp99(n: number): number {
    return Math.max(0, Math.min(99, n));
  }

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

  relativeTime(ms: number): string {
    if (!ms) return '—';
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  }
}

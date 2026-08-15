import { Component, inject, signal, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AgentsService } from '../../services/agents.service';
import { Agent } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-agents-panel',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './agents-panel.component.html',
  styleUrl: './agents-panel.component.css',
})
export class AgentsPanelComponent {
  agentsService = inject(AgentsService);
  minimized = signal(localStorage.getItem('hydra_agents_mini') === 'true');

  agentClicked = output<Agent>();
  agentDoubleClicked = output<Agent>();
  createAgentRequested = output<void>();

  // Single click waits briefly so a double click doesn't also open the chat tab
  private clickTimer: ReturnType<typeof setTimeout> | null = null;

  toggleMinimized(): void {
    this.minimized.update(v => !v);
    localStorage.setItem('hydra_agents_mini', String(this.minimized()));
  }

  onAgentClick(agent: Agent): void {
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.agentClicked.emit(agent);
    }, 250);
  }

  onAgentDblClick(agent: Agent): void {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.agentDoubleClicked.emit(agent);
  }

  statusColor(status: string): string {
    switch (status) {
      case 'online': return 'var(--status-online)';
      case 'working': return 'var(--status-working)';
      default: return 'var(--status-offline)';
    }
  }
}

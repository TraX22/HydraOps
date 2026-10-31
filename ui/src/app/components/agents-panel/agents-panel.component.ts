import { Component, inject, signal, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AgentsService } from '../../services/agents.service';
import { ChatService } from '../../services/chat.service';
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
  private chat = inject(ChatService);
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

  // offline (worker down) is RED — 'idle' (alive, nothing pending) keeps the
  // neutral grey. Painting both grey made a healthy idle agent look dead.
  /** The agent whose chat tab is active: marked in the rail, collapsed or not. */
  isActive(agent: Agent): boolean { return this.chat.activeTab() === agent.id; }

  statusColor(status: string): string {
    switch (status) {
      case 'online': return 'var(--status-online)';
      case 'working': return 'var(--status-working)';
      case 'offline': return 'var(--status-error)';
      default: return 'var(--status-offline)';
    }
  }
}

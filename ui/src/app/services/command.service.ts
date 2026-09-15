import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, CommandResult, CommandSpec } from './api.service';
import { ChatService } from './chat.service';
import { AgentsService } from './agents.service';
import { ComplementosService } from './complementos.service';

// The chat's "/commands": the catalog for the palette and the runner that
// sends a line to POST /api/commands, echoes the result as a system message
// in the chat and applies the action the backend asks for.
@Injectable({ providedIn: 'root' })
export class CommandService {
  private api = inject(ApiService);
  private chat = inject(ChatService);
  private agents = inject(AgentsService);
  private complementos = inject(ComplementosService);
  private router = inject(Router);

  readonly catalog = signal<CommandSpec[]>([]);
  readonly running = signal(false);

  load(): void {
    if (this.catalog().length) return;
    this.api.listCommands().subscribe({ next: c => this.catalog.set(c), error: () => {} });
  }

  // Palette entries for what the user typed after the slash: commands (by
  // name or alias) first, then agents (a "/luna …" one-off message).
  suggestions(token: string): PaletteItem[] {
    const t = token.toLowerCase();
    const cmds: PaletteItem[] = this.catalog()
      .filter(c => !t || c.name.startsWith(t) || c.aliases?.some(a => a.startsWith(t)))
      .map(c => ({ kind: 'command', name: c.name, usage: c.usage ?? `/${c.name}`, descriptionKey: `commands.${c.name}` }));
    const agents: PaletteItem[] = this.agents.agents()
      .filter(a => !t || a.id.toLowerCase().startsWith(t) || a.name.toLowerCase().startsWith(t))
      .map(a => ({ kind: 'agent', name: a.id, usage: `/${a.id} <message>`, descriptionKey: 'commands.agentMessage', agentName: a.name }));
    return [...cmds, ...agents];
  }

  run(line: string): void {
    const channel = this.chat.activeTab();
    this.chat.addSystemMessage(channel, line, 'echo');
    this.running.set(true);
    this.api.runCommand(line, channel).subscribe({
      next: r => {
        this.running.set(false);
        if (r.text) this.chat.addSystemMessage(channel, r.text, r.kind ?? 'info');
        this.apply(r);
      },
      error: err => {
        this.running.set(false);
        this.chat.addSystemMessage(channel, err?.error?.text ?? 'Command failed.', 'error');
      },
    });
  }

  private apply(r: CommandResult): void {
    const a = r.action;
    if (!a) return;
    switch (a.type) {
      case 'open_tab': {
        const agent = this.agents.agents().find(x => x.id === a.agentId);
        this.chat.openAgentTab(a.agentId, agent?.name ?? a.agentId, agent?.avatarUrl);
        break;
      }
      case 'main':
        this.chat.switchTab('main');
        break;
      case 'close_tab':
        this.chat.closeTab(this.chat.activeTab());
        break;
      case 'open_oneshot':
        this.complementos.openApp('one-shot');
        break;
      case 'navigate':
        this.router.navigate([a.path], { queryParams: a.query });
        break;
      // await_task: the reply lands in that agent's chat; nothing to wait for here.
    }
  }
}

export interface PaletteItem {
  kind: 'command' | 'agent';
  name: string;
  usage: string;
  descriptionKey: string;
  agentName?: string;
}

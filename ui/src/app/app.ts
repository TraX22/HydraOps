import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { AgentsPanelComponent } from './components/agents-panel/agents-panel.component';
import { AgentsService } from './services/agents.service';
import { ChatService } from './services/chat.service';
import { Agent } from './services/api.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, AgentsPanelComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private agentsService = inject(AgentsService);
  private chatService = inject(ChatService);
  private router = inject(Router);
  private translate = inject(TranslateService);

  // En /login no hay sesión: se esconde el armazón (sidebar + panel) y la
  // pantalla ocupa todo el ancho.
  protected readonly isLogin = signal(false);

  ngOnInit(): void {
    const savedLang = localStorage.getItem('hydra_lang');
    if (savedLang) this.translate.use(savedLang);
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      this.isLogin.set(this.router.url.startsWith('/login'));
    });
    this.agentsService.startPolling();
  }

  onAgentClicked(agent: Agent): void {
    this.chatService.openAgentTab(agent.id, agent.name, agent.avatarUrl);
    this.router.navigate(['/']);
  }

  onAgentDoubleClicked(agent: Agent): void {
    this.router.navigate(['/agents'], { queryParams: { select: agent.id } });
  }

  // Desde el estado vacío del panel: lleva a Agentes con el modal ya abierto.
  onCreateAgentRequested(): void {
    this.router.navigate(['/agents'], { queryParams: { new: 1 } });
  }
}

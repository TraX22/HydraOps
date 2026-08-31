import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import { ApiService, VersionInfo } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';
import { ComplementosService } from '../../services/complementos.service';

interface NavItem {
  path: string;
  icon: string;
  labelKey: string;
  section: 'main' | 'tools' | 'settings';
  // 'modal' items open an in-app overlay (e.g. Complementos) instead of routing.
  action?: 'modal';
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, TranslatePipe, IconComponent],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css',
})
export class SidebarComponent implements OnInit {
  theme = inject(ThemeService);
  private router = inject(Router);
  private api = inject(ApiService);
  private complementos = inject(ComplementosService);

  minimized = signal(localStorage.getItem('hydra_sidebar_mini') === 'true');
  version = signal<VersionInfo | null>(null);

  ngOnInit(): void {
    // La versión instalada, para mostrarla en el pie. Sin red no pasa nada:
    // `current` es local y llega igual; solo `latest` depende de GitHub.
    this.api.getVersion().subscribe({
      next: (v) => this.version.set(v),
      error: () => {},
    });
  }

  navItems: NavItem[] = [
    { path: '/', icon: 'chat', labelKey: 'nav.chat', section: 'main' },
    { path: '/agents', icon: 'agents', labelKey: 'nav.agents', section: 'main' },
    { path: '/system', icon: 'system', labelKey: 'nav.system', section: 'main' },
    { path: '#complementos', icon: 'puzzle', labelKey: 'nav.complementos', section: 'tools', action: 'modal' },
    { path: '/tasks', icon: 'tasks', labelKey: 'nav.tasks', section: 'tools' },
    { path: '/addons', icon: 'addons', labelKey: 'nav.addons', section: 'tools' },
    { path: '/herramientas', icon: 'tools', labelKey: 'nav.herramientas', section: 'tools' },
    { path: '/stats', icon: 'stats', labelKey: 'nav.stats', section: 'tools' },
    { path: '/docs', icon: 'docs', labelKey: 'nav.docs', section: 'tools' },
    { path: '/config', icon: 'config', labelKey: 'nav.config', section: 'settings' },
    { path: '/me', icon: 'me', labelKey: 'nav.me', section: 'settings' },
  ];

  get mainItems() { return this.navItems.filter(i => i.section === 'main'); }
  get toolItems() { return this.navItems.filter(i => i.section === 'tools'); }
  get settingItems() { return this.navItems.filter(i => i.section === 'settings'); }

  toggleMinimized(): void {
    this.minimized.update(v => !v);
    localStorage.setItem('hydra_sidebar_mini', String(this.minimized()));
  }

  toggleTheme(): void {
    this.theme.toggle();
  }

  openComplementos(): void {
    this.complementos.openHub();
  }

  isActive(path: string): boolean {
    if (path === '/') return this.router.url === '/';
    return this.router.url.startsWith(path);
  }
}

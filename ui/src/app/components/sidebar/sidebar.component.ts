import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import { ApiService, VersionInfo } from '../../services/api.service';

interface NavItem {
  path: string;
  icon: string;
  labelKey: string;
  section: 'main' | 'tools' | 'settings';
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css',
})
export class SidebarComponent implements OnInit {
  theme = inject(ThemeService);
  private router = inject(Router);
  private api = inject(ApiService);

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
    { path: '/', icon: '💬', labelKey: 'nav.chat', section: 'main' },
    { path: '/agents', icon: '🤖', labelKey: 'nav.agents', section: 'main' },
    { path: '/system', icon: '🖥️', labelKey: 'nav.system', section: 'main' },
    { path: '/tasks', icon: '⏰', labelKey: 'nav.tasks', section: 'tools' },
    { path: '/addons', icon: '🔌', labelKey: 'nav.addons', section: 'tools' },
    { path: '/stats', icon: '📊', labelKey: 'nav.stats', section: 'tools' },
    { path: '/docs', icon: '📚', labelKey: 'nav.docs', section: 'tools' },
    { path: '/config', icon: '⚙️', labelKey: 'nav.config', section: 'settings' },
    { path: '/me', icon: '👤', labelKey: 'nav.me', section: 'settings' },
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

  isActive(path: string): boolean {
    if (path === '/') return this.router.url === '/';
    return this.router.url.startsWith(path);
  }
}

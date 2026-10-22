import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import { IconComponent } from '../icon/icon.component';
import { ComplementosService } from '../../services/complementos.service';
import { UpdateService } from '../../services/update.service';

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
  private complementos = inject(ComplementosService);
  /** The update block in the footer: one state whatever the installation (see UpdateService). */
  updates = inject(UpdateService);

  minimized = signal(localStorage.getItem('hydra_sidebar_mini') === 'true');
  version = this.updates.version;
  upd = this.updates.state;

  /** Minutes since the last check, for the version line's tooltip. */
  checkedAgo = computed(() => {
    const st = this.upd();
    if (st.kind !== 'idle' || !st.checkedAt) return null;
    return Math.max(0, Math.round((Date.now() - st.checkedAt) / 60000));
  });

  ngOnInit(): void {
    // La versión instalada, para mostrarla en el pie, y el estado de las
    // actualizaciones: sin red no pasa nada, `current` es local y llega igual.
    this.updates.start();
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

  // ── The update block ──

  /** "89 de 141 MB" for the download line. */
  mb(bytes: number): string { return (bytes / 1048576).toFixed(0); }

  /** The error line: the server's short message, or a translated code. */
  errorKey(message: string): string | null {
    return ['timeout', 'update_failed', 'check_failed', 'not_git', 'no_git', 'dirty', 'no_release', 'up_to_date', 'backup_failed'].includes(message) ? 'update.errors.' + message : null;
  }
}

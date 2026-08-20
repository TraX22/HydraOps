import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./views/chat/chat.component').then(m => m.ChatComponent) },
  { path: 'agents', loadComponent: () => import('./views/agents/agents.component').then(m => m.AgentsComponent) },
  { path: 'system', loadComponent: () => import('./views/system/system.component').then(m => m.SystemComponent) },
  { path: 'config', loadComponent: () => import('./views/config/config.component').then(m => m.ConfigComponent) },
  { path: 'tasks', loadComponent: () => import('./views/cron/cron.component').then(m => m.CronComponent) },
  { path: 'addons', loadComponent: () => import('./views/addons/addons.component').then(m => m.AddonsComponent) },
  { path: 'herramientas', loadComponent: () => import('./views/herramientas/herramientas.component').then(m => m.HerramientasComponent) },
  { path: 'stats', loadComponent: () => import('./views/stats/stats.component').then(m => m.StatsComponent) },
  { path: 'docs', loadComponent: () => import('./views/docs/docs.component').then(m => m.DocsComponent) },
  { path: 'me', loadComponent: () => import('./views/me/me.component').then(m => m.MeComponent) },
  { path: 'login', loadComponent: () => import('./views/login/login.component').then(m => m.LoginComponent) },
  { path: '**', redirectTo: '' },
];

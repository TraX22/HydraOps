import { Injectable, signal } from '@angular/core';

// Which mini-app is active inside the Complementos overlay. 'hub' shows the
// grid of mini-apps; the rest are individual tools. Add future tools here.
export type ComplementoApp = 'hub' | 'one-shot';

// Controls the Complementos overlay ("pop up"): a hub of in-app mini-apps.
// Opened from the sidebar; hosted once in the app shell so it covers everything.
@Injectable({ providedIn: 'root' })
export class ComplementosService {
  readonly open = signal(false);
  readonly activeApp = signal<ComplementoApp>('hub');

  openHub(): void {
    this.activeApp.set('hub');
    this.open.set(true);
  }

  openApp(app: ComplementoApp): void {
    this.activeApp.set(app);
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.activeApp.set('hub');
  }
}

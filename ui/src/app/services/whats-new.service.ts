import { Injectable, inject, signal } from '@angular/core';
import { ApiService, ReleaseNotes } from './api.service';
import { ChatService, WHATS_NEW_TAB } from './chat.service';

const SEEN_KEY = 'hydra_whatsnew_seen';    // last version whose notes the user closed
const SHOWN_KEY = 'hydra_whatsnew_shown';  // last version that took the focus once

/**
 * The "What's new" chat tab. After an update the app ships the notes of every
 * release (docs/releases/<version>.md); this service asks for the ones newer
 * than the last version the user dismissed and, when there are any, shows the
 * tab. Closing it records the current version, so it stays away until the
 * next update. `/whatsnew` reopens it on demand.
 */
@Injectable({ providedIn: 'root' })
export class WhatsNewService {
  private api = inject(ApiService);
  private chat = inject(ChatService);

  readonly current = signal<string>('');
  readonly releases = signal<ReleaseNotes[]>([]);
  private checked = false;

  constructor() {
    this.chat.onWhatsNewClosed = () => this.dismiss();
  }

  /** Once per app load: show the tab when there are unseen release notes. */
  check(): void {
    if (this.checked) return;
    this.checked = true;
    const seen = this.read(SEEN_KEY);
    this.api.getWhatsNew(seen ? { since: seen } : {}).subscribe({
      next: r => {
        if (!r.current || !r.releases.length) return;
        this.current.set(r.current);
        this.releases.set(r.releases);
        this.chat.whatsNewOpen.set(true);
        // Take the focus only the first time this version is seen: the tab then
        // waits in the bar until closed, without hijacking every launch.
        if (this.read(SHOWN_KEY) !== r.current) {
          this.write(SHOWN_KEY, r.current);
          this.chat.switchTab(WHATS_NEW_TAB);
        }
      },
      error: () => { this.checked = false; /* offline or old backend: try again next time */ },
    });
  }

  /** `/whatsnew`: the latest releases, whether or not they were already seen. */
  open(): void {
    this.api.getWhatsNew({ all: true }).subscribe({
      next: r => {
        if (!r.releases.length) return;
        this.current.set(r.current ?? '');
        this.releases.set(r.releases);
        this.chat.whatsNewOpen.set(true);
        this.chat.switchTab(WHATS_NEW_TAB);
      },
      error: () => {},
    });
  }

  private dismiss(): void {
    if (this.current()) this.write(SEEN_KEY, this.current());
  }

  private read(key: string): string {
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  }

  private write(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }
}

import { Injectable, signal } from '@angular/core';

/** A link waiting for the user's answer, and where it sits on screen. */
export interface PendingLink {
  url: string;
  /** The address split for display: the host is what tells the user where they are going. */
  before: string;
  host: string;
  after: string;
  /** The link's box in the viewport, to place the balloon next to it. */
  rect: { left: number; top: number; bottom: number; width: number };
}

const SHOWN_CHARS = 220;

/**
 * Leaving the app is a decision: a click on a link that goes to the internet does not
 * open it, it asks first (LinkConfirmComponent shows the balloon). Links to the app's own
 * pages and files, and mail links, are not asked about.
 */
@Injectable({ providedIn: 'root' })
export class ExternalLinkService {
  readonly pending = signal<PendingLink | null>(null);

  /** A web address on another site than the app itself. */
  isExternal(href: string | null | undefined): boolean {
    if (!href) return false;
    try {
      const u = new URL(href, window.location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  /** Asks about `href`; `anchor` is the element that was clicked (the balloon goes next to it). */
  ask(href: string, anchor?: Element | null): void {
    let u: URL;
    try { u = new URL(href, window.location.href); } catch { return; }
    const box = anchor?.getBoundingClientRect();
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    this.pending.set({
      url: u.toString(),
      before: `${u.protocol}//`,
      // The host as the browser parsed it: a look-alike name shows in its encoded form.
      host: u.host,
      after: rest.length > SHOWN_CHARS ? rest.slice(0, SHOWN_CHARS) + '…' : rest,
      rect: box
        ? { left: box.left, top: box.top, bottom: box.bottom, width: box.width }
        : { left: window.innerWidth / 2 - 20, top: window.innerHeight / 2, bottom: window.innerHeight / 2, width: 40 },
    });
  }

  accept(): void {
    const p = this.pending();
    this.pending.set(null);
    // In the desktop shell this goes to the system browser (its window-open handler).
    if (p) window.open(p.url, '_blank', 'noopener');
  }

  cancel(): void {
    this.pending.set(null);
  }
}

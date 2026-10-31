import { Component, ElementRef, HostBinding, OnDestroy, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { IconComponent } from '../icon/icon.component';
import { BrowserPanelService, BrowserTab, BROWSER_MIN_WIDTH } from '../../services/browser-panel.service';

/**
 * The browser panel beside the chat: tabs, address bar, the eye that says whether an
 * agent may read a tab, and the page area. The page itself is not in this DOM: Electron
 * draws it over `.bp-page`, so this component keeps the shell told where that box is.
 */
@Component({
  selector: 'app-browser-panel',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './browser-panel.component.html',
  styleUrl: './browser-panel.component.css',
})
export class BrowserPanelComponent implements OnDestroy {
  readonly browser = inject(BrowserPanelService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private page = viewChild<ElementRef<HTMLElement>>('page');
  private address = viewChild<ElementRef<HTMLInputElement>>('address');

  /** What the address bar shows; follows the active tab unless the user is typing. */
  readonly draft = signal('');
  readonly editing = signal(false);
  /** The chat view's width, measured. */
  readonly avail = signal(0);
  /**
   * The width the panel really takes: the remembered one, capped so the chat column keeps
   * 380px, never under the minimum. The cap lives on the host, so the panel can never be
   * wider than the box it is given (a wider inner box would overflow under the agents rail
   * while the page view, drawn above everything, followed the overflow).
   */
  readonly effectiveWidth = computed(() => {
    const a = this.avail();
    const max = a > 0 ? Math.max(BROWSER_MIN_WIDTH, a - 380) : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(this.browser.width(), max));
  });
  @HostBinding('style.width.px') get hostWidth(): number { return this.effectiveWidth(); }
  private observer: ResizeObserver | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastRect = '';

  constructor() {
    effect(() => {
      const url = this.browser.active()?.url ?? '';
      if (!this.editing()) this.draft.set(url);
    });
    afterNextRender(() => {
      const el = this.page()?.nativeElement;
      if (!el) return;
      this.observer = new ResizeObserver(() => this.report());
      this.observer.observe(el);
      this.observer.observe(document.documentElement);
      const parent = this.host.nativeElement.parentElement;
      if (parent) this.observer.observe(parent);
      // The box can move without changing size (the sidebar collapses): a cheap check covers that.
      this.poll = setInterval(() => this.report(), 300);
      this.report();
      if (!this.browser.active()?.url) this.focusAddress();
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    if (this.poll) clearInterval(this.poll);
  }

  private report(): void {
    const el = this.page()?.nativeElement;
    if (!el) return;
    const parent = this.host.nativeElement.parentElement;
    if (parent) { const w = Math.round(parent.getBoundingClientRect().width); if (w !== this.avail()) this.avail.set(w); }
    const r = el.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key === this.lastRect) return;
    this.lastRect = key;
    this.browser.reportBounds(r);
  }

  focusAddress(): void {
    const input = this.address()?.nativeElement;
    if (input) { input.focus(); input.select(); }
  }

  // ── address bar ──
  onFocus(): void { this.editing.set(true); this.draft.set(this.browser.active()?.url ?? ''); queueMicrotask(() => this.address()?.nativeElement.select()); }
  onBlur(): void { this.editing.set(false); this.draft.set(this.browser.active()?.url ?? ''); }
  async go(): Promise<void> {
    const text = this.draft().trim();
    if (!text) return;
    const active = this.browser.active();
    if (active) await this.browser.navigate(text, active.id); else await this.browser.newTab(text);
    this.editing.set(false);
    this.address()?.nativeElement.blur();
  }
  cancelEdit(): void { this.editing.set(false); this.draft.set(this.browser.active()?.url ?? ''); this.address()?.nativeElement.blur(); }

  /** The host, shortened, and the path dimmed: what the bar shows when not editing. */
  hostOf(url: string): string { try { return new URL(url).host; } catch { return url; } }
  pathOf(url: string): string { try { const u = new URL(url); const p = u.pathname + u.search; return p === '/' ? '' : p; } catch { return ''; } }
  isSecure(url: string): boolean { return url.startsWith('https://'); }

  // ── tabs ──
  async addTab(): Promise<void> { await this.browser.newTab(); this.focusAddress(); }
  closeTab(tab: BrowserTab, event: Event): void { event.stopPropagation(); this.browser.closeTab(tab.id); }
  label(tab: BrowserTab): string { return tab.title || this.hostOf(tab.url) || ''; }
  toggleEye(tab: BrowserTab, event: Event): void { event.stopPropagation(); this.browser.toggleVisibility(tab); }

  // ── resize handle ──
  startDrag(event: PointerEvent): void {
    event.preventDefault();
    this.browser.dragging.set(true);
    const right = this.host.nativeElement.getBoundingClientRect().right;
    // The chat column keeps at least 380px of the chat view's width.
    const max = Math.max(BROWSER_MIN_WIDTH, (this.avail() || window.innerWidth) - 380);
    // Listened for on the window: the pointer leaves the thin handle at once, and while the
    // drag lasts the page view is hidden, so nothing else takes the events.
    const move = (e: PointerEvent) => this.browser.setWidth(Math.min(max, Math.max(BROWSER_MIN_WIDTH, right - e.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      this.browser.dragging.set(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  }
}

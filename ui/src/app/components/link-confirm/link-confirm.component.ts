import { Component, DestroyRef, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { IconComponent } from '../icon/icon.component';
import { ExternalLinkService } from '../../services/external-link.service';

const WIDTH = 340;
const HEIGHT = 150; // roughly; only used to decide whether it fits below the link
const MARGIN = 12;

/**
 * The balloon that asks before a link leaves the app: the address, with its host in bold,
 * and Cancel / Accept. It sits next to the link that was clicked. Escape, a click outside,
 * scrolling or resizing cancel; Enter accepts (the Accept button has the focus).
 *
 * It listens to every click in the document (capture phase), so it covers links in agent
 * replies, sources, the manual and the rest of the interface alike.
 */
@Component({
  selector: 'app-link-confirm',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  template: `
    @if (links.pending(); as p) {
      <div class="veil" (click)="links.cancel()"></div>
      <div class="balloon" role="dialog" aria-modal="true" [attr.aria-label]="'links.leaving' | translate"
           [class.above]="place().above" [style.left.px]="place().left" [style.top.px]="place().top">
        <span class="arrow" [style.left.px]="place().arrow"></span>
        <h4><app-icon name="external-link" /> {{ 'links.leaving' | translate }}</h4>
        <div class="url">{{ p.before }}<b>{{ p.host }}</b>{{ p.after }}</div>
        <div class="actions">
          <button type="button" class="btn" (click)="links.cancel()">{{ 'common.cancel' | translate }}</button>
          <button #accept type="button" class="btn primary" (click)="links.accept()">{{ 'links.accept' | translate }}</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .veil { position: fixed; inset: 0; z-index: 900; }
    .balloon {
      position: fixed; z-index: 901; width: ${WIDTH}px; max-width: calc(100vw - ${MARGIN * 2}px);
      background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg); padding: 14px 16px; color: var(--text-primary);
    }
    .arrow {
      position: absolute; top: -7px; width: 12px; height: 12px; background: var(--bg-surface);
      border-left: 1px solid var(--border-color); border-top: 1px solid var(--border-color); transform: rotate(45deg);
    }
    .balloon.above .arrow { top: auto; bottom: -7px; transform: rotate(225deg); }
    h4 { margin: 0 0 8px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    h4 app-icon { color: var(--accent); font-size: 16px; }
    .url {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.45;
      background: var(--bg-input); border-radius: var(--radius-sm); padding: 7px 10px; word-break: break-all;
      max-height: 96px; overflow: auto;
    }
    .url b { font-weight: 700; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .btn {
      font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: var(--radius-sm);
      padding: 6px 16px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary);
    }
    .btn:hover { background: var(--bg-hover); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { background: var(--accent-hover); }
  `],
})
export class LinkConfirmComponent {
  protected readonly links = inject(ExternalLinkService);
  private readonly acceptBtn = viewChild<ElementRef<HTMLButtonElement>>('accept');

  // Under the link when it fits, above it otherwise; kept inside the window, with the
  // arrow pointing at the link.
  protected readonly place = computed(() => {
    const p = this.links.pending();
    if (!p) return { left: 0, top: 0, arrow: 0, above: false };
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const center = p.rect.left + Math.min(p.rect.width, 120) / 2;
    const left = Math.max(MARGIN, Math.min(center - 50, window.innerWidth - width - MARGIN));
    const above = p.rect.bottom + 10 + HEIGHT > window.innerHeight && p.rect.top - 10 - HEIGHT > 0;
    const top = above ? p.rect.top - 10 - HEIGHT : p.rect.bottom + 10;
    const arrow = Math.max(14, Math.min(center - left - 6, width - 26));
    return { left, top, arrow, above };
  });

  constructor() {
    // The Accept button takes the focus when the balloon opens, so Enter accepts.
    effect(() => {
      if (this.links.pending()) queueMicrotask(() => this.acceptBtn()?.nativeElement.focus());
    });
    // Capture phase, before any view handles the click (the manual and the chat have
    // their own click handlers on rendered HTML).
    const onClick = (e: Event) => this.onDocumentClick(e as MouseEvent);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.links.pending()) { e.stopPropagation(); this.links.cancel(); } };
    const onMoved = (e: Event) => this.onMoved(e);
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onMoved, true);
    document.addEventListener('wheel', onMoved, true);
    window.addEventListener('resize', onMoved);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onMoved, true);
      document.removeEventListener('wheel', onMoved, true);
      window.removeEventListener('resize', onMoved);
    });
  }

  // A link that leaves the app is asked about instead of opened.
  private onDocumentClick(event: MouseEvent): void {
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest('app-link-confirm')) return;
    const link = target.closest('a[href]') as HTMLAnchorElement | null;
    if (!link || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (!this.links.isExternal(href)) return;
    event.preventDefault();
    event.stopPropagation();
    this.links.ask(href!, link);
  }

  // The balloon is tied to where the link was: once the page moves, the question is
  // dropped (scrolling the address inside the balloon itself does not count).
  private onMoved(event: Event): void {
    if (!this.links.pending()) return;
    const target = event.target as Element | null;
    if (target?.closest?.('app-link-confirm .balloon')) return;
    this.links.cancel();
  }
}

import { AfterViewInit, Directive, ElementRef, OnDestroy, inject, input } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

const STORE_KEY = 'hydra_cards_open';
const SVG = 'http://www.w3.org/2000/svg';
/** The arrow (Lucide's chevron-down, as in app-icon): it points down on a folded card and up on an open one. */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  svg.appendChild(path);
  return svg;
}

function openCards(): Set<string> {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []); }
  catch { return new Set(); }
}
function remember(key: string, open: boolean): void {
  const all = openCards();
  if (open) all.add(key); else all.delete(key);
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...all])); } catch { /* storage blocked */ }
}

/**
 * A card of the Add-ons and Tools views that folds: `<div class="tool-card" appFoldCard="tool:git">`.
 *
 * Folded (how every card starts, from the first run) it shows its head only, with the
 * description cut to its first line, so the page reads as a list. A card that has more than
 * that (fields under the head, or a description longer than one line) gets an arrow at the end
 * of its head to open and fold it; one that has nothing more gets none. What the user opened
 * stays open (remembered per card in this browser).
 *
 * The head is the card's `.tool-head` or `.addon-row`; a card with neither is all head. The
 * styles are global (styles.css, "Folding cards"), since the cards belong to several components.
 */
@Directive({ selector: '[appFoldCard]', standalone: true })
export class FoldCardDirective implements AfterViewInit, OnDestroy {
  /** What the card is, to remember whether it was opened: "addon:web_search", "tool:git". */
  key = input.required<string>({ alias: 'appFoldCard' });

  private host: HTMLElement = inject(ElementRef).nativeElement;
  private translate = inject(TranslateService);
  private open = false;
  private button?: HTMLButtonElement;
  private mutations?: MutationObserver;
  private sizes?: ResizeObserver;
  private lang?: Subscription;
  private frame = 0;

  ngAfterViewInit(): void {
    this.open = openCards().has(this.key());
    this.host.classList.add('fold-card');
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'card-fold';
    this.button.appendChild(chevron());
    this.button.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    this.host.addEventListener('click', this.onHeadClick);
    this.apply();
    // The card's content can arrive later (it is loaded), and its width changes with the window.
    this.mutations = new MutationObserver(() => this.later());
    this.mutations.observe(this.host, { childList: true, subtree: true, characterData: true });
    this.sizes = new ResizeObserver(() => this.later());
    this.sizes.observe(this.host);
    this.lang = this.translate.onLangChange.subscribe(() => this.later());
  }

  ngOnDestroy(): void {
    this.mutations?.disconnect();
    this.sizes?.disconnect();
    this.lang?.unsubscribe();
    cancelAnimationFrame(this.frame);
    this.host.removeEventListener('click', this.onHeadClick);
  }

  private later(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.apply());
  }

  private head(): HTMLElement | null {
    for (const child of Array.from(this.host.children)) {
      if (child.classList.contains('tool-head') || child.classList.contains('addon-row')) return child as HTMLElement;
    }
    return null;
  }

  /** A click on the head opens or folds the card, unless it landed on something of its own (a switch, a field, a link). */
  private onHeadClick = (event: MouseEvent): void => {
    if (!this.host.classList.contains('fold-more')) return;
    const target = event.target as HTMLElement | null;
    const head = this.head() ?? this.host;
    if (!target || !head.contains(target) || target.closest('button, a, input, select, textarea, label')) return;
    this.toggle();
  };

  private toggle(): void {
    this.open = !this.open;
    remember(this.key(), this.open);
    this.apply();
  }

  /** Whether the description is longer than the one line a folded card shows. */
  private descriptionOverflows(): boolean {
    const desc = this.host.querySelector<HTMLElement>('.addon-type');
    if (!desc) return false;
    if (this.host.classList.contains('fold-closed')) return desc.scrollWidth > desc.clientWidth + 1;
    const line = parseFloat(getComputedStyle(desc).lineHeight) || 16;
    return desc.offsetHeight > line * 1.6;
  }

  private apply(): void {
    const button = this.button;
    if (!button) return;
    const head = this.head();
    // The arrow sits at the end of the head (or of the card, when the card is all head).
    const place = head ?? this.host;
    if (button.parentElement !== place || place.lastElementChild !== button) {
      this.mutations?.disconnect();
      place.appendChild(button);
      this.mutations?.observe(this.host, { childList: true, subtree: true, characterData: true });
    }
    this.host.classList.toggle('fold-has-head', !!head);
    const hasBody = !!head && Array.from(this.host.children).some((c) => c !== head && c !== button);
    // Measured as it will be shown folded, so the answer does not depend on the state it is in.
    this.host.classList.toggle('fold-closed', !this.open);
    const more = hasBody || this.descriptionOverflows();
    this.host.classList.toggle('fold-more', more);
    button.hidden = !more;
    const label = this.translate.instant(this.open ? 'common.foldCard' : 'common.openCard');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(this.open));
  }
}

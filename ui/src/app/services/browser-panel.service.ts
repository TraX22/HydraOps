import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { ThemeService } from './theme.service';

/** One tab of the browser panel, as the desktop shell reports it. */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
  error: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The user's choice: readable only while active (auto), always (on) or never (off). */
  visibility: 'auto' | 'on' | 'off';
  /** Whether an agent may read it right now (derived from visibility and which tab is active). */
  readable: boolean;
}

export interface BrowserState {
  activeId: string | null;
  tabs: BrowserTab[];
}

interface BrowserBridge {
  state(): Promise<BrowserState>;
  onState(cb: (s: BrowserState) => void): () => void;
  bounds(rect: { x: number; y: number; width: number; height: number }): void;
  shown(shown: boolean): void;
  panel(open: boolean): void;
  /** The shell asks the interface to show the panel (an agent opened a page in it). */
  onOpenPanel(cb: () => void): () => void;
  background(color: string): void;
  newTab(url?: string): Promise<string>;
  closeTab(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  navigate(id: string | null, input: string): Promise<boolean>;
  back(id: string | null): Promise<void>;
  forward(id: string | null): Promise<void>;
  reload(id: string | null): Promise<void>;
  stop(id: string | null): Promise<void>;
  setVisibility(id: string, visibility: BrowserTab['visibility']): Promise<void>;
  openExternal(id: string | null): Promise<void>;
}

const OPEN_KEY = 'hydra_browser_open';
const WIDTH_KEY = 'hydra_browser_width';
export const BROWSER_MIN_WIDTH = 360;
/** Anything drawn over the chat (a modal, a lightbox, the plugins window): the panel's pages must hide under it. */
const OVERLAY_SELECTOR = '.cmp-overlay, .lightbox-backdrop, .modal-overlay, .model-backdrop, .lc-backdrop, .drop-overlay';

/**
 * The browser panel beside the chat. Only the desktop app has it: the pages are real
 * Chromium views that Electron draws over the area this panel reserves, so the service
 * tells the shell where that area is and whether the pages may be on screen at all
 * (panel open, chat view mounted, nothing overlaid, not mid-resize, a page to show).
 */
@Injectable({ providedIn: 'root' })
export class BrowserPanelService {
  private readonly bridge: BrowserBridge | undefined = (window as unknown as { hydraDesktop?: { browser?: BrowserBridge } }).hydraDesktop?.browser;
  private theme = inject(ThemeService);

  /** The desktop shell provides a browser; in a plain browser or server mode there is none. */
  readonly available = !!this.bridge;
  readonly open = signal<boolean>(this.load(OPEN_KEY) === '1');
  readonly width = signal<number>(Math.max(BROWSER_MIN_WIDTH, Number(this.load(WIDTH_KEY)) || 480));
  readonly state = signal<BrowserState>({ activeId: null, tabs: [] });
  /** The chat view is on screen (it attaches on init and detaches on destroy). */
  readonly attached = signal(false);
  /** Something is drawn over the chat. */
  readonly covered = signal(false);
  /** The user is dragging the panel's edge. */
  readonly dragging = signal(false);

  readonly active = computed(() => { const s = this.state(); return s.tabs.find((t) => t.id === s.activeId) ?? null; });
  /** Whether the active page should be visible right now. */
  readonly pageShown = computed(() => this.available && this.open() && this.attached() && !this.covered() && !this.dragging() && !!this.active()?.url);

  constructor() {
    if (!this.bridge) return;
    const bridge = this.bridge;
    bridge.onState((s) => this.state.set(s));
    bridge.onOpenPanel?.(() => this.open.set(true));
    bridge.state().then((s) => s && this.state.set(s)).catch(() => {});
    effect(() => bridge.panel(this.open()));
    effect(() => bridge.shown(this.pageShown()));
    effect(() => { try { localStorage.setItem(OPEN_KEY, this.open() ? '1' : '0'); } catch { /* storage blocked */ } });
    effect(() => { try { localStorage.setItem(WIDTH_KEY, String(this.width())); } catch { /* storage blocked */ } });
    effect(() => bridge.background(this.theme.theme() === 'dark' ? '#0f0f1a' : '#f0f2f5'));
    this.watchOverlays();
  }

  toggle(): void { this.open.update((v) => !v); }
  attach(): void { this.attached.set(true); }
  detach(): void { this.attached.set(false); }
  setWidth(px: number): void { this.width.set(Math.round(px)); }

  /** The page area, in CSS pixels of the window (what the shell needs to place the view). */
  reportBounds(rect: DOMRect): void { this.bridge?.bounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }); }

  newTab(url = ''): Promise<string> { return this.bridge?.newTab(url) ?? Promise.resolve(''); }
  closeTab(id: string): void { void this.bridge?.closeTab(id); }
  activate(id: string): void { void this.bridge?.activate(id); }
  navigate(input: string, id: string | null = null): Promise<boolean> { return this.bridge?.navigate(id, input) ?? Promise.resolve(false); }
  back(): void { void this.bridge?.back(null); }
  forward(): void { void this.bridge?.forward(null); }
  reload(): void { void this.bridge?.reload(null); }
  stop(): void { void this.bridge?.stop(null); }
  openExternal(): void { void this.bridge?.openExternal(null); }

  /** One click on the eye: the active tab goes readable ↔ off; a background tab goes readable ↔ auto. */
  toggleVisibility(tab: BrowserTab): void {
    const isActive = tab.id === this.state().activeId;
    const next: BrowserTab['visibility'] = isActive ? (tab.visibility === 'off' ? 'auto' : 'off') : (tab.visibility === 'on' ? 'auto' : 'on');
    void this.bridge?.setVisibility(tab.id, next);
  }

  private watchOverlays(): void {
    const check = () => this.covered.set(!!document.querySelector(OVERLAY_SELECTOR));
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
  }

  private load(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
}

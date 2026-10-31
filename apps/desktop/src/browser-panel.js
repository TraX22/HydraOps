/**
 * browser-panel.js — the browser panel beside the chat: real Chromium tabs inside the
 * main window, one WebContentsView per tab, placed over the space the Angular chat
 * reserves for them.
 *
 * Why a WebContentsView and not an <iframe> in the UI: nearly every site refuses to be
 * framed (X-Frame-Options, CSP), and an iframe shares nothing with the user's sessions.
 * The views live in the main process and draw ABOVE the renderer, so the UI tells us where
 * the panel is (`setBounds`) and when it must disappear (`setShown`: panel closed, another
 * view open, an overlay on top).
 *
 * Tabs keep their own persistent profile (`persist:hydraops-browser`), separate from the
 * app's renderer: cookies and logins survive a restart, and nothing of the app's preload
 * reaches a page. Every view is sandboxed, with no Node integration.
 *
 * Agents (a later step): each tab has a `visibility` the user controls — "auto" (readable
 * only while it is the active tab), "on" (always readable) or "off" (never). The snapshot
 * reports `readable` per tab; this module stores the choice, the tools come separately.
 *
 * Tabs (url, title, visibility) are saved to a JSON file and restored the first time the
 * panel opens after a start, not before, so a start costs nothing when the panel is closed.
 */
const { WebContentsView, Menu, clipboard, session, shell, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PARTITION = "persist:hydraops-browser";
const NEW_TAB = "about:blank";
const MAX_TABS = 20;
const ALLOWED_SCHEMES = new Set(["http:", "https:", "about:"]);

/** What the user typed into the address bar → a URL: a scheme-less host gets https, anything else is a search. */
function toUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return NEW_TAB;
  if (/^(https?:\/\/|about:)/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null; // another scheme (file:, javascript:…): refused
  // host[:port][/path] without spaces, with a dot or "localhost". Local and private hosts
  // (a ComfyUI, a NAS, this very app) rarely speak TLS: they get http, the rest https.
  if (!/\s/.test(text) && (/^localhost(:\d+)?(\/|$)/i.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text))) {
    const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:|\/|$)/i.test(text);
    return `${local ? "http" : "https"}://${text}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

function isAllowed(url) {
  try { return ALLOWED_SCHEMES.has(new URL(url).protocol); } catch { return false; }
}

class BrowserPanel {
  /**
   * @param {object} o
   * @param {import("electron").BrowserWindow} o.window
   * @param {string} o.stateFile  where the tabs are saved
   * @param {(msg: string) => void} o.log
   * @param {() => object} o.strings  the context-menu labels in the current language
   */
  constructor({ window, stateFile, log, strings }) {
    this.window = window;
    this.stateFile = stateFile;
    this.log = log || (() => {});
    this.strings = strings || (() => ({}));
    /** @type {Map<string, {id: string, view: WebContentsView, visibility: "auto"|"on"|"off", title: string, url: string, favicon: string, loading: boolean, error: string}>} */
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.bounds = null;
    this.shown = false;
    /** The interface has the panel open: only then is the active tab "the one the user looks at". */
    this.panelOpen = false;
    this.restored = false;
    this.background = "#0f0f1a";
    this.saveTimer = null;
    this.pushTimer = null;
    this.seq = 0;
    this.ses = session.fromPartition(PARTITION);
    this.ses.setPermissionRequestHandler((_wc, permission, callback) => {
      // Pages get no camera, microphone, location, notifications, USB… Full screen is harmless.
      callback(permission === "fullscreen");
    });
    this.ses.setPermissionCheckHandler((_wc, permission) => permission === "fullscreen");
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Called when the UI opens the panel: restores the saved tabs once, or opens an empty one. */
  ensureTabs() {
    if (this.restored) return;
    this.restored = true;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")); } catch { /* first time */ }
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((t) => t && isAllowed(String(t.url || ""))).slice(0, MAX_TABS) : [];
    for (const t of tabs) this.newTab(String(t.url), { visibility: t.visibility, activate: false, title: t.title });
    const want = Number.isInteger(saved?.active) ? this.order[saved.active] : null;
    if (want) this.activate(want); else if (this.order.length) this.activate(this.order[this.order.length - 1]);
    if (!this.order.length) this.newTab(NEW_TAB);
    this.log(`navegador: ${this.order.length} pestaña(s) restaurada(s)`);
  }

  setPanelOpen(open) {
    this.panelOpen = !!open;
    if (this.panelOpen) this.ensureTabs();
    this.changed();
  }

  /** May an agent read this tab right now? Its eye on, or the tab the user is looking at. */
  isReadable(tab) {
    return tab.visibility === "on" || (tab.visibility === "auto" && this.panelOpen && tab.id === this.activeId);
  }

  /** The tabs an agent may read right now, the active one first. */
  readableTabs() {
    const list = this.order.map((id) => this.tabs.get(id)).filter((t) => this.isReadable(t));
    return list.sort((a, b) => (a.id === this.activeId ? -1 : b.id === this.activeId ? 1 : 0));
  }

  /**
   * The tab an agent asked for (a piece of its title or address, or its id) among the readable
   * ones, or the readable one when nothing was asked. Null when none fits: a named tab that
   * is not readable is refused, never swapped for another.
   */
  readableTab(ref) {
    const wanted = String(ref || "").trim().toLowerCase();
    const candidates = this.readableTabs();
    if (!candidates.length) return null;
    if (!wanted) return candidates[0];
    return candidates.find((t) => t.id === wanted || (t.title || "").toLowerCase().includes(wanted) || (t.view.webContents.getURL() || "").toLowerCase().includes(wanted)) || null;
  }

  /** An agent opens a page (after the user's approval): in the active tab, or a new one. Returns the tab id, or null if refused. */
  openForAgent(url, newTab) {
    if (!isAllowed(url) || url === NEW_TAB) return null;
    this.ensureTabs();
    const active = this.tabs.get(this.activeId);
    if (newTab || !active || !active.url || active.url === NEW_TAB) {
      if (active && (!active.url || active.url === NEW_TAB)) { this.navigate(active.id, url); return active.id; }
      return this.newTab(url, { activate: true });
    }
    this.navigate(active.id, url);
    return active.id;
  }

  /** The state the API keeps for the tools: the tabs with their readability, and whether the panel is open. */
  snapshotForAgents() {
    const s = this.snapshot();
    return { panelOpen: this.panelOpen, activeId: s.activeId, tabs: s.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, readable: t.readable, loading: t.loading })) };
  }

  destroy() {
    clearTimeout(this.saveTimer); clearTimeout(this.pushTimer);
    this.saveNow();
    for (const id of [...this.order]) this.dropView(id);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────────

  newTab(url = NEW_TAB, { visibility = "auto", activate = true, title = "" } = {}) {
    if (this.order.length >= MAX_TABS) { this.log("navegador: tope de pestañas"); return this.activeId; }
    // What the UI sends may be what the user typed (no scheme, or a search): normalise it too.
    const target = url === NEW_TAB || !url ? NEW_TAB : isAllowed(url) ? url : (toUrl(url) || NEW_TAB);
    const id = `t${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
    });
    view.setBackgroundColor(this.background);
    const tab = { id, view, visibility: ["auto", "on", "off"].includes(visibility) ? visibility : "auto", title: title || "", url: target, favicon: "", loading: false, error: "" };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.wire(tab);
    // A new empty tab stays on the initial blank document: loading about:blank would put a
    // useless first entry in its history.
    if (target !== NEW_TAB) view.webContents.loadURL(target).catch(() => {});
    if (activate) this.activate(id); else this.changed();
    return id;
  }

  closeTab(id) {
    if (!this.tabs.has(id)) return;
    const idx = this.order.indexOf(id);
    this.dropView(id);
    if (this.activeId === id) {
      const next = this.order[Math.min(idx, this.order.length - 1)] ?? null;
      this.activeId = null;
      if (next) this.activate(next); else this.changed();
    } else {
      this.changed();
    }
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.activeId && this.activeId !== id) {
      const prev = this.tabs.get(this.activeId);
      if (prev) this.detach(prev);
    }
    this.activeId = id;
    this.attach(tab);
    this.changed();
  }

  navigate(id, input) {
    const tab = this.tabs.get(id ?? this.activeId);
    if (!tab) return false;
    const url = toUrl(input);
    if (!url) { this.log(`navegador: dirección rechazada (${String(input).slice(0, 60)})`); return false; }
    tab.error = "";
    tab.view.webContents.loadURL(url).catch(() => {});
    return true;
  }

  back(id) { const t = this.tabs.get(id ?? this.activeId); if (t?.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); }
  forward(id) { const t = this.tabs.get(id ?? this.activeId); if (t?.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); }
  reload(id) { const t = this.tabs.get(id ?? this.activeId); if (t) { t.error = ""; t.view.webContents.reload(); } }
  stop(id) { const t = this.tabs.get(id ?? this.activeId); if (t) t.view.webContents.stop(); }

  setVisibility(id, visibility) {
    const tab = this.tabs.get(id);
    if (!tab || !["auto", "on", "off"].includes(visibility)) return;
    tab.visibility = visibility;
    this.changed();
  }

  openExternal(id) {
    const tab = this.tabs.get(id ?? this.activeId);
    const url = tab?.view.webContents.getURL();
    if (url && /^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  }

  // ── Placement ─────────────────────────────────────────────────────────────────

  /** Where the panel's page area is, in the renderer's CSS pixels. */
  setBounds(rect) {
    if (!rect || !(rect.width >= 0) || !(rect.height >= 0)) return;
    this.bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    this.place();
  }

  /** Whether the active view may be on screen right now (panel open, chat visible, nothing over it). */
  setShown(shown) {
    this.shown = !!shown;
    if (this.shown) this.ensureTabs();
    const tab = this.tabs.get(this.activeId);
    if (tab) { if (this.shown) this.attach(tab); else this.detach(tab); }
  }

  setBackground(color) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return;
    this.background = color;
    for (const t of this.tabs.values()) t.view.setBackgroundColor(color);
  }

  place() {
    const tab = this.tabs.get(this.activeId);
    if (!tab || !this.bounds || !tab.attached) return;
    // The UI measures in its CSS pixels; the window places views in DIPs. They differ only
    // by the interface zoom (View → Zoom in/out), never by the monitor's scaling.
    const z = this.window.webContents.getZoomFactor() || 1;
    tab.view.setBounds({ x: Math.round(this.bounds.x * z), y: Math.round(this.bounds.y * z), width: Math.max(0, Math.round(this.bounds.width * z)), height: Math.max(0, Math.round(this.bounds.height * z)) });
  }

  attach(tab) {
    if (!this.shown || !this.window || this.window.isDestroyed()) return;
    if (!tab.attached) {
      this.window.contentView.addChildView(tab.view);
      tab.attached = true;
    }
    this.place();
  }

  detach(tab) {
    if (!tab.attached || !this.window || this.window.isDestroyed()) { tab.attached = false; return; }
    try { this.window.contentView.removeChildView(tab.view); } catch { /* already gone */ }
    tab.attached = false;
  }

  dropView(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.detach(tab);
    try { tab.view.webContents.close(); } catch { /* closing */ }
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  // ── Events from the pages ─────────────────────────────────────────────────────

  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => this.changed();
    wc.on("page-title-updated", (_e, title) => { tab.title = title; update(); });
    wc.on("did-start-loading", () => { tab.loading = true; update(); });
    wc.on("did-stop-loading", () => { tab.loading = false; tab.url = wc.getURL(); update(); });
    wc.on("did-navigate", (_e, url) => { tab.url = url; tab.error = ""; update(); });
    wc.on("did-navigate-in-page", (_e, url, isMain) => { if (isMain) { tab.url = url; update(); } });
    wc.on("page-favicon-updated", (_e, icons) => { tab.favicon = icons?.[0] || ""; update(); });
    wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3: a navigation we replaced
      tab.error = `${desc || "load failed"} (${code})`; tab.url = url || tab.url; update();
    });
    wc.on("render-process-gone", (_e, details) => { this.log(`navegador: la pestaña se cayó (${details.reason}); se recarga`); tab.error = details.reason; update(); });
    // Links that want a new window open as a new tab here; anything else is refused.
    wc.setWindowOpenHandler(({ url }) => { if (isAllowed(url) && url !== NEW_TAB) this.newTab(url, { activate: true }); return { action: "deny" }; });
    const keep = (event, url) => { if (!isAllowed(url)) { event.preventDefault(); this.log(`navegador: navegación bloqueada ${String(url).slice(0, 80)}`); } };
    wc.on("will-navigate", keep);
    wc.on("will-redirect", keep);
    wc.on("context-menu", (_e, params) => this.contextMenu(tab, params));
    wc.on("focus", () => { if (this.activeId !== tab.id) this.activate(tab.id); });
  }

  contextMenu(tab, params) {
    const all = this.strings();
    const s = all.browser || {};
    const m = all.menu || {};
    const wc = tab.view.webContents;
    const items = [];
    if (params.linkURL && isAllowed(params.linkURL)) {
      items.push({ label: s.openLinkNewTab || "Open link in new tab", click: () => this.newTab(params.linkURL) });
      items.push({ label: s.copyLink || "Copy link address", click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: "separator" });
    }
    if (params.isEditable) {
      items.push({ role: "undo", label: m.undo }, { role: "redo", label: m.redo }, { type: "separator" }, { role: "cut", label: m.cut }, { role: "copy", label: m.copy }, { role: "paste", label: m.paste }, { role: "selectAll", label: m.selectAll }, { type: "separator" });
    } else if (params.selectionText) {
      items.push({ role: "copy", label: m.copy }, { type: "separator" });
    }
    if (params.srcURL && /^https?:/i.test(params.srcURL)) {
      items.push({ label: s.copyImageAddress || "Copy image address", click: () => clipboard.writeText(params.srcURL) }, { type: "separator" });
    }
    items.push(
      { label: s.back || "Back", enabled: wc.navigationHistory.canGoBack(), click: () => this.back(tab.id) },
      { label: s.forward || "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => this.forward(tab.id) },
      { label: s.reload || "Reload", click: () => this.reload(tab.id) },
      { type: "separator" },
      { label: s.openExternal || "Open in the system browser", click: () => this.openExternal(tab.id) },
    );
    // A role item without a label gets Electron's own label in the system language.
    Menu.buildFromTemplate(items.map((i) => (i.label === undefined ? Object.fromEntries(Object.entries(i).filter(([k]) => k !== "label")) : i))).popup({ window: this.window });
  }

  // ── State out ─────────────────────────────────────────────────────────────────

  snapshot() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        const wc = t.view.webContents;
        const url = t.url || wc.getURL();
        return {
          id, title: t.title || (url === NEW_TAB ? "" : url), url: url === NEW_TAB ? "" : url, favicon: t.favicon, loading: t.loading, error: t.error,
          canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
          visibility: t.visibility, readable: this.isReadable(t),
        };
      }),
    };
  }

  changed() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send("browser:state", this.snapshot());
      // The bridge keeps the API's copy of the state fresh (see browser-bridge.js).
      this.onChange?.();
    }, 16);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    if (!this.restored) return;
    const data = {
      tabs: this.order.map((id) => { const t = this.tabs.get(id); const url = t.view.webContents.getURL() || t.url; return { url: url === NEW_TAB ? "" : url, title: t.title, visibility: t.visibility }; }).filter((t) => t.url),
      active: Math.max(0, this.order.indexOf(this.activeId)),
    };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) { this.log(`navegador: no se pudo guardar el estado (${e.message})`); }
  }
}

module.exports = { BrowserPanel, toUrl, isAllowed, PARTITION };

/**
 * browser-bridge.js — how the agents reach the browser panel.
 *
 * The tools (`browser_read`, `browser_open`) run in the workers, which only know the API.
 * The pages live here, in the Electron main process, which has no server of its own. So
 * the shell is a client of the API: it long-polls `POST /api/browser/shell/poll` with the
 * panel's current state, receives one request at a time ({ id, kind, args }), performs it
 * on the page view and posts the answer to `POST /api/browser/shell/result`. The API keeps
 * the tool's HTTP call waiting meanwhile (see the browser bridge block in apps/api).
 *
 * What a read returns is whatever the page shows: title, address, the visible text as
 * light Markdown (headings, lists, links), the links, and on request a screenshot. Never
 * the value of an input (passwords included), never cookies, never a hidden element. The
 * worker marks the result as outside content, like a fetch_url result.
 *
 * Which tab: the one the user is looking at (the active tab while the panel is open) or a
 * tab whose eye is switched on. Nothing else, whatever the model asks for.
 */
const POLL_TIMEOUT_MS = 30_000;
const RETRY_MS = 3_000;
const LOAD_TIMEOUT_MS = 15_000;
const MAX_TEXT = 60_000;
const MAX_LINKS = 60;
const SHOT_WIDTH = 1024;

/** Runs inside the page: the visible content as light Markdown, plus the links. */
const EXTRACT = `(() => {
  const MAX_TEXT = ${MAX_TEXT}, MAX_LINKS = ${MAX_LINKS};
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION", "HEAD"]);
  const block = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE", "UL", "OL", "TABLE", "TR", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "BR", "HR", "FORM", "FIELDSET", "DETAILS", "SUMMARY"]);
  const visible = (el) => { const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && !(el.getAttribute("aria-hidden") === "true"); };
  const out = [];
  let total = 0, truncated = false;
  const push = (s) => { if (truncated) return; if (total + s.length > MAX_TEXT) { s = s.slice(0, Math.max(0, MAX_TEXT - total)); truncated = true; } out.push(s); total += s.length; };
  const text = (node) => node.textContent.replace(/\\s+/g, " ").trim();
  const walk = (node, depth) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) { const t = node.textContent.replace(/\\s+/g, " "); if (t.trim()) push(t); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node, tag = el.tagName;
    if (skip.has(tag) || !visible(el)) return;
    if (/^H[1-6]$/.test(tag)) { push("\\n\\n" + "#".repeat(Number(tag[1])) + " " + text(el) + "\\n\\n"); return; }
    if (tag === "A" && el.getAttribute("href")) { const t = text(el); if (t) push("[" + t + "](" + el.href + ")"); return; }
    if (tag === "IMG") { const alt = (el.getAttribute("alt") || "").trim(); if (alt) push("[image: " + alt + "]"); return; }
    if (tag === "LI") { push("\\n- "); for (const c of el.childNodes) walk(c, depth + 1); return; }
    if (tag === "TD" || tag === "TH") { for (const c of el.childNodes) walk(c, depth + 1); push(" | "); return; }
    if (tag === "PRE") { push("\\n\\n\`\`\`\\n" + el.textContent.replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000) + "\\n\`\`\`\\n\\n"); return; }
    if (block.has(tag)) push("\\n");
    for (const c of el.childNodes) walk(c, depth + 1);
    if (block.has(tag)) push("\\n");
  };
  walk(document.body || document.documentElement, 0);
  const md = out.join("").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= MAX_LINKS) break;
    if (!visible(a)) continue;
    const href = a.href; if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const t = text(a); if (!t) continue;
    seen.add(href); links.push({ text: t.slice(0, 120), href });
  }
  return { title: document.title, url: location.href, text: md, links, truncated, lang: document.documentElement.lang || "" };
})()`;

/**
 * @param {object} o
 * @param {() => string} o.apiBase   e.g. "http://127.0.0.1:3000/api" ("" while unknown)
 * @param {() => import("./browser-panel").BrowserPanel | null} o.panel
 * @param {(msg: string) => void} o.log
 * @param {() => void} o.showPanel   asks the interface to open the panel (the agent opened a page)
 */
function startBrowserBridge({ apiBase, panel, log, showPanel }) {
  let stopped = false;
  let failures = 0;
  /** The poll in flight: aborted when the panel's state changes, so the API gets the new state at once. */
  let polling = null;
  let dirty = false;

  async function post(path, body, timeoutMs, ctl = new AbortController()) {
    const base = apiBase();
    if (!base) throw new Error("no api yet");
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) throw new Error(`${path} → ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Called by the panel on every change: the parked poll is replaced by one carrying the fresh state. */
  function stateChanged() {
    dirty = true;
    if (polling) polling.abort();
  }

  async function handle(req) {
    const p = panel();
    if (!p) throw Object.assign(new Error("the browser panel is not running"), { code: "no_browser" });
    if (req.kind === "read") return read(p, req.args || {});
    if (req.kind === "open") return open(p, req.args || {});
    throw new Error(`unknown request ${req.kind}`);
  }

  async function read(p, { tab, screenshot }) {
    const t = p.readableTab(tab);
    if (!t) {
      const readable = p.readableTabs();
      const why = readable.length
        ? `the tab "${String(tab).slice(0, 60)}" is not readable (its eye is off); readable now: ${readable.map((r) => `"${r.title || r.url}"`).join(", ")}`
        : p.panelOpen ? "no tab is readable: the active tab's eye is off and no other tab is switched on" : "the browser panel is closed and no tab is switched on for the agents";
      throw Object.assign(new Error(why), { code: "not_readable" });
    }
    const wc = t.view.webContents;
    if (wc.isLoading()) await waitLoaded(wc, 8_000).catch(() => {});
    const page = await wc.executeJavaScript(EXTRACT, true);
    const result = { tabId: t.id, title: page.title || t.title, url: page.url || wc.getURL(), text: page.text, links: page.links, truncated: page.truncated, lang: page.lang };
    if (screenshot) {
      try {
        const img = await wc.capturePage();
        const size = img.getSize();
        const scaled = size.width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH }) : img;
        result.screenshot = { mime: "image/jpeg", base64: scaled.toJPEG(72).toString("base64"), width: scaled.getSize().width, height: scaled.getSize().height };
      } catch (e) { log(`navegador: no se pudo capturar la pestaña (${e.message})`); }
    }
    return result;
  }

  async function open(p, { url, newTab }) {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) throw Object.assign(new Error("only http and https addresses can be opened"), { code: "bad_url" });
    const id = p.openForAgent(target, !!newTab);
    if (!id) throw Object.assign(new Error("the address was refused"), { code: "bad_url" });
    showPanel();
    const t = p.tabs.get(id);
    await waitLoaded(t.view.webContents, LOAD_TIMEOUT_MS).catch(() => {});
    return { tabId: id, title: t.title || t.view.webContents.getTitle(), url: t.view.webContents.getURL() || target, error: t.error || "" };
  }

  function waitLoaded(wc, ms) {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); wc.removeListener("did-stop-loading", done); resolve(); };
      const timer = setTimeout(() => { wc.removeListener("did-stop-loading", done); reject(new Error("load timeout")); }, ms);
      wc.once("did-stop-loading", done);
    });
  }

  async function loop() {
    while (!stopped) {
      let aborted = false;
      try {
        const p = panel();
        if (p && p.onChange !== stateChanged) p.onChange = stateChanged;
        const snapshot = p ? p.snapshotForAgents() : null;
        dirty = false;
        polling = new AbortController();
        const ctl = polling;
        const req = await post("/browser/shell/poll", { snapshot }, POLL_TIMEOUT_MS, ctl).catch((e) => { if (ctl.signal.aborted && dirty) { aborted = true; return null; } throw e; });
        polling = null;
        if (aborted) continue; // the state changed: poll again with it right away
        failures = 0;
        if (req && req.id) {
          let answer;
          try {
            answer = { id: req.id, ok: true, result: await handle(req) };
          } catch (e) {
            answer = { id: req.id, ok: false, error: e.message || String(e), code: e.code || "failed" };
          }
          await post("/browser/shell/result", answer, 10_000).catch((e) => log(`navegador: no se pudo entregar la respuesta (${e.message})`));
        }
      } catch (e) {
        polling = null;
        failures++;
        if (failures === 1 || failures % 20 === 0) log(`navegador: el puente con la API no responde (${e.message}); reintentando`);
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }
  loop();
  return { stop() { stopped = true; polling?.abort(); } };
}

module.exports = { startBrowserBridge, EXTRACT };

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
 * Runs inside the page: finds the element an action names by what a person sees (the text of a
 * button or link, the label or placeholder of a field, the text of an option's select), never
 * by a selector. Returns its box in viewport coordinates, or why it could not be chosen: not
 * found, ambiguous (with the candidates), or sensitive (passwords, cards, file inputs are never
 * touched). `spec` = { action, target }.
 */
const LOCATE = (spec) => `(() => {
  const spec = ${JSON.stringify(spec)};
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const want = norm(spec.target);
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const sensitive = (el) => {
    const t = (el.getAttribute("type") || "").toLowerCase(), ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const n = ((el.getAttribute("name") || "") + " " + (el.id || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
    return t === "password" || t === "file" || /^cc-|credit|card/.test(ac) || /passw|pwd|contrase|cvv|cvc|card.?number|tarjeta/.test(n);
  };
  const labelOf = (el) => {
    const parts = [];
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.textContent); }
    const pl = el.closest("label"); if (pl) parts.push(pl.textContent);
    parts.push(el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name"));
    if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button")) parts.push(el.value);
    if (el.tagName === "SELECT") { const o = el.options[el.selectedIndex]; parts.push(o ? o.textContent : ""); }
    if (el.tagName !== "SELECT" && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") parts.push(el.textContent);
    return parts.filter(Boolean).map(norm).filter(Boolean);
  };
  const display = (el) => { const l = labelOf(el); return (l.find((x) => x.length) || el.tagName.toLowerCase()).slice(0, 80); };
  const score = (el) => { const ls = labelOf(el); if (!want) return 1; if (ls.some((l) => l === want)) return 3; if (ls.some((l) => l.startsWith(want))) return 2; if (ls.some((l) => l.includes(want))) return 1; return 0; };
  const SEL = {
    click: 'a[href], button, [role="button"], input[type="submit"], input[type="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], summary, label, [onclick]',
    type: 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable="true"]',
    select: 'select',
    submit: 'input:not([type=hidden]), textarea, select, button[type=submit], input[type=submit], form',
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const found = (el, extra) => Object.assign({ ok: true, label: display(el), tag: el.tagName.toLowerCase(), box: box(el) }, extra || {});
  if (spec.action === "scroll") {
    const w = want;
    if (!w || w === "down" || w === "abajo") { window.scrollBy({ top: window.innerHeight * 0.8, behavior: "instant" }); return { ok: true, label: "down" }; }
    if (w === "up" || w === "arriba") { window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "instant" }); return { ok: true, label: "up" }; }
    if (w === "top" || w === "inicio") { window.scrollTo({ top: 0, behavior: "instant" }); return { ok: true, label: "top" }; }
    if (w === "bottom" || w === "final") { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }); return { ok: true, label: "bottom" }; }
    const all = [...document.querySelectorAll("h1,h2,h3,h4,p,li,a,button,label,td,th,div,span,section,article")].filter((el) => visible(el) && norm(el.textContent).includes(w));
    const el = all.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!el) return { ok: false, code: "not_found" };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return found(el);
  }
  let pool = [...document.querySelectorAll(SEL[spec.action] || SEL.click)].filter(visible);
  if (spec.action === "submit") {
    // The named thing is a field or a button of the form, or the form itself; what is submitted is the form.
    const scored = pool.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const pick = scored[0]?.el || (want ? null : document.querySelector("form"));
    if (!pick) return { ok: false, code: "not_found" };
    const form = pick.tagName === "FORM" ? pick : pick.form || pick.closest("form");
    if (!form) return { ok: false, code: "not_found", detail: "the element is not in a form" };
    const btn = [...form.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')].find(visible);
    (btn || form).scrollIntoView({ block: "center", behavior: "instant" });
    return found(btn || form, { form: true, viaButton: !!btn });
  }
  pool = pool.filter((el) => !(el.tagName === "LABEL" && spec.action !== "click"));
  const scored = pool.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { ok: false, code: "not_found", candidates: pool.slice(0, 8).map(display) };
  const top = scored.filter((x) => x.s === scored[0].s);
  // Several equal matches: a label and its own control count as one.
  const distinct = top.filter((x, i) => !top.some((y, j) => j < i && (y.el.contains(x.el) || x.el.contains(y.el) || (x.el.tagName === "LABEL" && x.el.control === y.el) || (y.el.tagName === "LABEL" && y.el.control === x.el))));
  if (distinct.length > 1) return { ok: false, code: "ambiguous", candidates: distinct.slice(0, 6).map((x) => display(x.el)) };
  let el = distinct[0].el;
  if (el.tagName === "LABEL" && el.control && spec.action !== "click") el = el.control;
  if (spec.action === "click" && el.tagName === "LABEL" && el.control) el = el.control;
  if ((spec.action === "type" || spec.action === "select" || spec.action === "click") && (el.matches("input, textarea") || el.tagName === "SELECT") && sensitive(el)) return { ok: false, code: "sensitive", label: display(el) };
  if (spec.action === "type" && el.tagName === "SELECT") return { ok: false, code: "not_found", detail: "that is a select: use the select action" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const extra = {};
  if (spec.action === "select") extra.options = [...el.options].map((o) => o.textContent.trim()).slice(0, 40);
  return found(el, extra);
})()`;

/** Runs inside the page: a short outline around a box, so the user sees what the agent is about to touch. */
const HIGHLIGHT = (box, ms) => `(() => {
  const b = ${JSON.stringify(box)};
  const d = document.createElement("div");
  d.setAttribute("data-hydraops-highlight", "1");
  Object.assign(d.style, { position: "fixed", left: (b.x - 4) + "px", top: (b.y - 4) + "px", width: (b.w + 8) + "px", height: (b.h + 8) + "px", border: "3px solid #6366f1", borderRadius: "8px", boxShadow: "0 0 0 4px rgba(99,102,241,.25)", pointerEvents: "none", zIndex: "2147483647", transition: "opacity .3s" });
  document.documentElement.appendChild(d);
  setTimeout(() => { d.style.opacity = "0"; setTimeout(() => d.remove(), 300); }, ${Number(ms) || 700});
  return true;
})()`;

/** Runs inside the page: sets a select's option by its visible text (or value), with the events a user would cause. */
const SELECT_OPTION = (box, text) => `(() => {
  const want = ${JSON.stringify(String(text))}.replace(/\\s+/g, " ").trim().toLowerCase();
  const el = document.elementFromPoint(${Number(box.x) + Number(box.w) / 2}, ${Number(box.y) + Number(box.h) / 2});
  const sel = el && (el.tagName === "SELECT" ? el : el.closest("select"));
  if (!sel) return { ok: false, code: "not_found" };
  const opt = [...sel.options].find((o) => o.textContent.replace(/\\s+/g, " ").trim().toLowerCase() === want) || [...sel.options].find((o) => o.value.toLowerCase() === want) || [...sel.options].find((o) => o.textContent.toLowerCase().includes(want));
  if (!opt) return { ok: false, code: "not_found", candidates: [...sel.options].map((o) => o.textContent.trim()).slice(0, 40) };
  sel.focus(); sel.value = opt.value;
  sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: opt.textContent.trim() };
})()`;

/** Runs inside the page: submits the form under a box (used when it has no visible submit button). */
const SUBMIT_FORM = (box) => `(() => {
  const el = document.elementFromPoint(${Number(box.x) + Number(box.w) / 2}, ${Number(box.y) + Number(box.h) / 2});
  const form = el && (el.tagName === "FORM" ? el : el.closest("form"));
  if (!form) return { ok: false, code: "not_found" };
  if (form.requestSubmit) form.requestSubmit(); else form.submit();
  return { ok: true };
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
    if (req.kind === "act") return act(p, req.args || {});
    throw new Error(`unknown request ${req.kind}`);
  }

  /**
   * An approved action on the readable tab: click, type, select, submit or scroll, on the
   * element the agent named by what it shows. Real input events (a user gesture for the page),
   * a highlight first so the user sees the target, and a short report of what happened.
   */
  async function act(p, { action, target, text, enter, tab }) {
    const t = p.readableTab(tab);
    if (!t) {
      const readable = p.readableTabs();
      const why = readable.length
        ? `the tab "${String(tab).slice(0, 60)}" is not readable (its eye is off); readable now: ${readable.map((r) => `"${r.title || r.url}"`).join(", ")}`
        : p.panelOpen ? "no tab is readable: the active tab's eye is off and no other tab is switched on" : "the browser panel is closed and no tab is switched on for the agents";
      throw Object.assign(new Error(why), { code: "not_readable" });
    }
    const kind = String(action || "").toLowerCase();
    if (!["click", "type", "select", "submit", "scroll"].includes(kind)) throw Object.assign(new Error(`unknown action "${kind}"`), { code: "bad_action" });
    const wc = t.view.webContents;
    if (wc.isLoading()) await waitLoaded(wc, 8_000).catch(() => {});
    showPanel();
    p.activate(t.id);
    const before = { url: wc.getURL(), title: wc.getTitle() };
    const hit = await wc.executeJavaScript(LOCATE({ action: kind, target: String(target || "") }), true);
    if (!hit?.ok) {
      const msg = hit?.code === "sensitive" ? `"${hit.label}" is a password, card or file field: agents never touch those`
        : hit?.code === "ambiguous" ? `"${String(target).slice(0, 60)}" matches several elements: ${hit.candidates.map((c) => `"${c}"`).join(", ")}. Name one of them more exactly.`
        : `nothing visible matches "${String(target).slice(0, 60)}"${hit?.detail ? ` (${hit.detail})` : ""}${hit?.candidates?.length ? `; visible here: ${hit.candidates.map((c) => `"${c}"`).join(", ")}` : ""}`;
      throw Object.assign(new Error(msg), { code: hit?.code === "sensitive" ? "sensitive" : "not_found" });
    }
    if (hit.box) { await wc.executeJavaScript(HIGHLIGHT(hit.box, 700), true).catch(() => {}); await new Promise((r) => setTimeout(r, 750)); }
    let navStarted = false;
    const onStart = () => { navStarted = true; };
    wc.once("did-start-navigation", onStart);
    const center = hit.box ? { x: Math.round(hit.box.x + hit.box.w / 2), y: Math.round(hit.box.y + hit.box.h / 2) } : null;
    const clickAt = (c) => { wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y }); wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 }); };
    const pressEnter = () => { wc.sendInputEvent({ type: "keyDown", keyCode: "Return" }); wc.sendInputEvent({ type: "char", keyCode: "Return" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Return" }); };
    let did = "";
    if (kind === "click") { clickAt(center); did = `clicked "${hit.label}"`; }
    else if (kind === "type") {
      clickAt(center);
      await new Promise((r) => setTimeout(r, 120));
      // Replace what the field had: select all, then insert as typed text (input events included).
      wc.selectAll();
      await wc.insertText(String(text ?? ""));
      if (enter) { await new Promise((r) => setTimeout(r, 80)); pressEnter(); }
      did = `typed into "${hit.label}"${enter ? " and pressed Enter" : ""}`;
    } else if (kind === "select") {
      const r = await wc.executeJavaScript(SELECT_OPTION(hit.box, String(text ?? "")), true);
      if (!r?.ok) throw Object.assign(new Error(`no option "${String(text).slice(0, 60)}" in "${hit.label}"${r?.candidates ? `; options: ${r.candidates.map((c) => `"${c}"`).join(", ")}` : ""}`), { code: "not_found" });
      did = `selected "${r.label}" in "${hit.label}"`;
    } else if (kind === "submit") {
      if (hit.viaButton) clickAt(center); else { const r = await wc.executeJavaScript(SUBMIT_FORM(hit.box), true); if (!r?.ok) throw Object.assign(new Error("the form could not be submitted"), { code: "not_found" }); }
      did = `submitted the form${hit.viaButton ? ` via "${hit.label}"` : ""}`;
    } else { did = `scrolled to ${hit.label}`; }
    // Give a navigation a moment to start, then settle.
    await new Promise((r) => setTimeout(r, 600));
    wc.removeListener("did-start-navigation", onStart);
    if (navStarted || wc.isLoading()) await waitLoaded(wc, LOAD_TIMEOUT_MS).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const page = await wc.executeJavaScript(EXTRACT, true).catch(() => null);
    return {
      tabId: t.id, did, title: wc.getTitle(), url: wc.getURL(),
      navigated: wc.getURL() !== before.url, titleChanged: wc.getTitle() !== before.title,
      excerpt: page?.text ? page.text.slice(0, 1200) : "",
    };
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

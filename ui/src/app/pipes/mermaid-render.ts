// Turns the ```mermaid placeholders emitted by the markdown pipe into real SVG
// diagrams. The mermaid library is heavy (~1.5 MB), so it loads as its own lazy
// chunk the first time a diagram actually appears — never in the initial bundle.
//
// Content arrives via [innerHTML], so there is no Angular hook per block: a
// MutationObserver on the container picks up new `.mermaid-block` elements as
// messages render. The diagram source stays in the DOM (hidden once rendered)
// so a theme switch can re-render every diagram with the matching palette.

let mermaidPromise: Promise<any> | null = null;
let initializedTheme = '';
let seq = 0;

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// Diagrams in the app's own palette rather than mermaid's grey defaults: indigo
// accent, the app's surfaces and text, one distinct colour per pie slice / git
// branch / actor. Built from the base theme so both app themes get the same look.
function themeVariables(theme: 'dark' | 'light'): Record<string, string> {
  const dark = theme === 'dark';
  const accent = dark ? '#818cf8' : '#6366f1';
  const text = dark ? '#e2e8f0' : '#1a1a2e';
  const surface = dark ? '#1a1a2e' : '#ffffff';
  const line = dark ? '#8b93c7' : '#64748b';
  const border = dark ? '#3b3f6b' : '#c7d2fe';
  return {
    darkMode: String(dark),
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '14px',
    // Nodes (flowchart, state, class…)
    primaryColor: dark ? '#2a2c55' : '#eef2ff',
    primaryTextColor: text,
    primaryBorderColor: accent,
    secondaryColor: dark ? '#173d3a' : '#ecfdf5',
    secondaryTextColor: text,
    secondaryBorderColor: '#22c55e',
    tertiaryColor: dark ? '#4a2f14' : '#fffbeb',
    tertiaryTextColor: text,
    tertiaryBorderColor: '#f59e0b',
    lineColor: line,
    textColor: text,
    mainBkg: dark ? '#2a2c55' : '#eef2ff',
    nodeBorder: accent,
    clusterBkg: dark ? '#16162a' : '#f8fafc',
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: surface,
    // Sequence diagrams
    actorBkg: dark ? '#2a2c55' : '#eef2ff',
    actorBorder: accent,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: dark ? '#2a2c55' : '#eef2ff',
    labelBoxBorderColor: accent,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: dark ? '#4a2f14' : '#fef3c7',
    noteBorderColor: '#f59e0b',
    noteTextColor: dark ? '#fde68a' : '#78350f',
    activationBkgColor: dark ? '#3b3f6b' : '#e0e7ff',
    activationBorderColor: accent,
    // Pie / git / timeline: one colour per slice or branch.
    pie1: '#6366f1', pie2: '#22c55e', pie3: '#f59e0b', pie4: '#ec4899', pie5: '#06b6d4',
    pie6: '#8b5cf6', pie7: '#f97316', pie8: '#14b8a6', pie9: '#e11d48', pie10: '#84cc16',
    pie11: '#0ea5e9', pie12: '#a855f7',
    pieTitleTextColor: text, pieSectionTextColor: '#ffffff', pieLegendTextColor: text,
    pieStrokeColor: surface, pieOuterStrokeColor: border,
    git0: '#6366f1', git1: '#22c55e', git2: '#f59e0b', git3: '#ec4899', git4: '#06b6d4',
    git5: '#8b5cf6', git6: '#f97316', git7: '#14b8a6',
    gitBranchLabel0: '#ffffff', gitBranchLabel1: '#ffffff', gitBranchLabel2: '#ffffff', gitBranchLabel3: '#ffffff',
    commitLabelColor: text, commitLabelBackground: surface, tagLabelColor: text, tagLabelBackground: dark ? '#4a2f14' : '#fef3c7', tagLabelBorder: '#f59e0b',
    // Gantt / timeline
    sectionBkgColor: dark ? '#2a2c55' : '#eef2ff', altSectionBkgColor: surface, sectionBkgColor2: dark ? '#173d3a' : '#ecfdf5',
    taskBkgColor: accent, taskBorderColor: accent, taskTextColor: '#ffffff', taskTextLightColor: '#ffffff', taskTextDarkColor: text,
    activeTaskBkgColor: '#f59e0b', activeTaskBorderColor: '#f59e0b', doneTaskBkgColor: dark ? '#3b3f6b' : '#c7d2fe', doneTaskBorderColor: border,
    gridColor: border, todayLineColor: '#ef4444',
  };
}

async function getMermaid(): Promise<any> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = currentTheme();
  // initialize() is cheap and idempotent; re-run it whenever the app theme
  // changed so the next render() uses the matching palette.
  if (theme !== initializedTheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(theme),
      fontFamily: 'inherit',
      flowchart: { curve: 'basis', padding: 12, htmlLabels: true },
    });
    initializedTheme = theme;
  }
  return mermaid;
}

async function renderBlock(block: HTMLElement): Promise<void> {
  const src = block.querySelector('.mermaid-src')?.textContent?.trim() ?? '';
  if (!src) {
    block.dataset['state'] = 'error';
    return;
  }
  const id = `hydra-mmd-${++seq}`;
  try {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(id, src);
    const holder = document.createElement('div');
    holder.className = 'mermaid-svg';
    holder.innerHTML = svg;
    block.appendChild(holder);
    block.dataset['state'] = 'done';
  } catch {
    // Invalid diagram: keep the source visible as a plain code block. mermaid
    // can leave its scratch element behind on a parse error — clean it up.
    document.getElementById('d' + id)?.remove();
    block.dataset['state'] = 'error';
  }
}

function renderAllIn(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-state])').forEach((block) => {
    block.dataset['state'] = 'pending';
    void renderBlock(block);
  });
}

/**
 * Start rendering mermaid blocks inside `root` and keep doing so as content is
 * added (new chat messages, another docs page). Returns a cleanup function.
 */
export function watchMermaid(root: HTMLElement): () => void {
  const contentObserver = new MutationObserver(() => renderAllIn(root));
  contentObserver.observe(root, { childList: true, subtree: true });

  // App theme switch → drop every rendered SVG and re-render from the kept source.
  const themeObserver = new MutationObserver(() => {
    root.querySelectorAll<HTMLElement>('.mermaid-block[data-state]').forEach((block) => {
      delete block.dataset['state'];
      block.querySelector('.mermaid-svg')?.remove();
    });
    renderAllIn(root);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Click a rendered diagram → full screen; click again or Esc → back in place.
  const onClick = (ev: Event) => {
    const svgHolder = (ev.target as HTMLElement).closest('.mermaid-svg');
    const block = svgHolder?.closest<HTMLElement>('.mermaid-block');
    if (!block) return;
    root.querySelectorAll('.mermaid-block.zoomed').forEach((b) => b !== block && b.classList.remove('zoomed'));
    block.classList.toggle('zoomed');
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') root.querySelectorAll('.mermaid-block.zoomed').forEach((b) => b.classList.remove('zoomed'));
  };
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  renderAllIn(root);
  return () => {
    contentObserver.disconnect();
    themeObserver.disconnect();
    root.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
  };
}

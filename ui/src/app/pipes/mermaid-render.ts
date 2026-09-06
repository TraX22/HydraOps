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

function currentTheme(): 'dark' | 'neutral' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'neutral';
}

async function getMermaid(): Promise<any> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = currentTheme();
  // initialize() is cheap and idempotent; re-run it whenever the app theme
  // changed so the next render() uses the matching mermaid palette.
  if (theme !== initializedTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' });
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

  renderAllIn(root);
  return () => {
    contentObserver.disconnect();
    themeObserver.disconnect();
  };
}

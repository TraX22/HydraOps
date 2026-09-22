import DOMPurify from 'dompurify';

/**
 * Everything the markdown pipe renders goes through here before it reaches
 * [innerHTML]. Markdown lets raw HTML through, and what an agent writes is not
 * trusted input: a model can be steered by a page it read (prompt injection)
 * into emitting script-bearing tags, a fake "paste your API key" form, a
 * full-screen overlay, or an image whose URL carries conversation data out.
 *
 * Policy:
 *  - DOMPurify's defaults (no script, no event handlers, no javascript: URLs…)
 *  - no embedding or form elements, no <style>, no inline style attribute
 *  - links: web and mail only, always target="_blank" rel="noopener noreferrer"
 *  - images: same-origin or data: only; a remote image becomes a plain link, so
 *    rendering a reply never makes a request to a third-party server
 */
const FORBID_TAGS = [
  'style', 'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta',
  'audio', 'video', 'source', 'track', 'dialog', 'marquee', 'portal',
];

// Where the app itself serves pictures from. Same origin alone is not enough: an
// <img> pointing at an API route would make the reader's browser call it.
const MEDIA_PATHS = ['/storage/', '/avatars/', '/img/', '/users/', '/api/docs/img/'];

function isLocalImage(src: string): boolean {
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return true;
  try {
    const url = new URL(src, location.href);
    return url.origin === location.origin && MEDIA_PATHS.some((p) => url.pathname.startsWith(p));
  } catch {
    return false;
  }
}

let configured = false;
function configure(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else if (!href.startsWith('#') && !/^(\.{1,2}\/)?[\w./-]+\.md(#[\w-]*)?$/i.test(href)) {
        // In-page anchors and the manual's own page links (./05-agents.md, handled by
        // the Docs view) stay; any other scheme or app-relative path loses its href,
        // so a reply cannot send the window to an arbitrary route of the app.
        el.removeAttribute('href');
      }
    } else if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      if (!isLocalImage(src)) {
        // Keep what the author meant (there is an image at this address) without fetching it.
        const link = el.ownerDocument.createElement('a');
        const label = el.getAttribute('alt') || src;
        link.textContent = `🖼 ${label}`;
        if (/^https?:/i.test(src)) {
          link.setAttribute('href', src);
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        }
        el.replaceWith(link);
      }
    }
  });
}

/**
 * The copy button of code blocks is markup the pipe itself generates, so it is the
 * one <button> allowed back — by exact class, with nothing but its icon inside.
 */
const COPY_BUTTON_CLASS = 'code-copy';

export function sanitizeHtml(html: string): string {
  configure();
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: FORBID_TAGS.filter((t) => t !== 'button'),
    FORBID_ATTR: ['style', 'srcset', 'ping', 'formaction', 'action', 'background', 'poster'],
    ADD_ATTR: ['target'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  clean.querySelectorAll('button').forEach((b) => {
    const ours = b.className === COPY_BUTTON_CLASS && b.closest('.code-block') && !b.querySelector(':not(svg):not(svg *)');
    if (!ours) b.replaceWith(...Array.from(b.childNodes));
  });

  const holder = document.createElement('div');
  holder.appendChild(clean);
  return holder.innerHTML;
}

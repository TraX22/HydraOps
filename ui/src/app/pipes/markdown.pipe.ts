import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
// Must import first: puts Prism on the global so the language files below can
// extend it (they reference a global `Prism`, which a bundler doesn't provide).
import Prism from './prism-setup';
import { sanitizeHtml } from './sanitize-html';

// Prism language grammars (core already bundles markup/css/clike/javascript).
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';

// Common language aliases → Prism grammar id.
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', ts: 'typescript', 'c#': 'csharp', cs: 'csharp',
  py: 'python', sh: 'bash', shell: 'bash', yml: 'yaml', html: 'markup', xml: 'markup',
};

// Inline clipboard icon (matches the app's icon set); handled by chat click delegation.
const COPY_BTN =
  '<button class="code-copy" type="button" title="Copy" aria-label="Copy">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">' +
  '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
  '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg></button>';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// A page of the manual, as the docs link to each other: ./05-agents.md, 12-server-mode.md#ports
const DOC_LINK = /^(\.{1,2}\/)?[\w./-]+\.md(#[\w-]*)?$/i;

// Render fenced code as a framed block with a language label, a copy button, and
// Prism syntax highlighting. Configured once at module load.
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    // Web and mail links always open outside the app (a new tab in the browser, the
    // system browser in the desktop shell): a plain link would navigate the app away.
    // In-page anchors and the manual's own page links (./05-agents.md) stay inside —
    // the Docs view handles their clicks. Anything else stays as text.
    // sanitize-html.ts enforces the same rule on the final HTML.
    link(this: any, token: any) {
      const href = String(token?.href ?? '');
      const text = token?.tokens ? this.parser.parseInline(token.tokens) : escapeHtml(String(token?.text ?? href));
      const title = token?.title ? ` title="${escapeAttr(String(token.title))}"` : '';
      if (/^(https?:|mailto:)/i.test(href)) {
        return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      if (href.startsWith('#') || DOC_LINK.test(href)) {
        return `<a href="${escapeAttr(href)}"${title}>${text}</a>`;
      }
      return text;
    },
    code(token: any) {
      const text: string = typeof token === 'string' ? token : token.text ?? '';
      const rawLang: string = typeof token === 'string' ? '' : token.lang ?? '';
      const lang = (rawLang || '').trim().split(/\s+/)[0].toLowerCase();
      // Mermaid fences become a placeholder that mermaid-render.ts upgrades to
      // an SVG diagram after the HTML lands in the DOM. The source stays inside
      // (hidden once rendered; shown as plain code if the diagram is invalid).
      if (lang === 'mermaid') {
        return `<div class="mermaid-block"><pre class="mermaid-src">${escapeHtml(text)}</pre></div>`;
      }
      const grammarId = LANG_ALIAS[lang] || lang;
      const grammar = grammarId ? Prism.languages[grammarId] : undefined;
      const highlighted = grammar ? Prism.highlight(text, grammar, grammarId) : escapeHtml(text);
      const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span class="code-lang"></span>';
      return (
        `<div class="code-block"><div class="code-head">${label}${COPY_BTN}</div>` +
        `<pre class="code-pre"><code class="prism${grammarId ? ' language-' + grammarId : ''}">${highlighted}</code></pre></div>`
      );
    },
  },
});

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string): SafeHtml {
    if (!value) return '';
    // Markdown passes raw HTML through and an agent's text is not trusted input:
    // sanitize first (see sanitize-html.ts). The bypass below is then only telling
    // Angular not to strip the classes and attributes our own renderer relies on.
    const html = sanitizeHtml(marked.parse(value) as string);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}

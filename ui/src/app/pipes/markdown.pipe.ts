import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
// Must import first: puts Prism on the global so the language files below can
// extend it (they reference a global `Prism`, which a bundler doesn't provide).
import Prism from './prism-setup';

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

// Render fenced code as a framed block with a language label, a copy button, and
// Prism syntax highlighting. Configured once at module load.
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(token: any) {
      const text: string = typeof token === 'string' ? token : token.text ?? '';
      const rawLang: string = typeof token === 'string' ? '' : token.lang ?? '';
      const lang = (rawLang || '').trim().split(/\s+/)[0].toLowerCase();
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
    const html = marked.parse(value) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}

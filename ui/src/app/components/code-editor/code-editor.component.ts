import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, output, viewChild } from '@angular/core';
import { Compartment, EditorState, Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap } from '@codemirror/view';
import { StreamLanguage, StreamParser } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';

// A code editor (CodeMirror 6, MIT) for one file of a project.
//
// The host gives the text once (`text`) and asks for the current one with value(); a new
// text is put in with setText() (a reload from disk). `marks` are the lines that differ
// from the user's commit: they are drawn with a bar at the left and follow the text as it
// is edited. Each language's grammar is loaded when a file of that kind is first opened.

const setMarks = StateEffect.define<number[]>();
const markLine = Decoration.line({ class: 'cm-changed-line' });

/** The marked lines, kept as decorations so they move with the text under an edit. */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const total = tr.state.doc.lines;
      for (const n of [...new Set(e.value)].filter(n => n >= 1 && n <= total).sort((a, b2) => a - b2)) {
        const from = tr.state.doc.line(n).from;
        b.add(from, from, markLine);
      }
      value = b.finish();
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

const legacy = (load: () => Promise<StreamParser<unknown>>) => async (): Promise<Extension> => StreamLanguage.define(await load());

/** The grammar for a file, by its name. Nothing for a kind that has none: the file is plain text. */
function languageFor(path: string): (() => Promise<Extension>) | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx': return async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'js': case 'mjs': case 'cjs': return async () => (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx': return async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'html': case 'htm': case 'vue': case 'svelte': return async () => (await import('@codemirror/lang-html')).html();
    case 'css': case 'scss': case 'less': return async () => (await import('@codemirror/lang-css')).css();
    case 'json': case 'jsonc': case 'webmanifest': return async () => (await import('@codemirror/lang-json')).json();
    case 'md': case 'markdown': return async () => (await import('@codemirror/lang-markdown')).markdown();
    case 'php': return async () => (await import('@codemirror/lang-php')).php();
    case 'py': return async () => (await import('@codemirror/lang-python')).python();
    case 'sql': return async () => (await import('@codemirror/lang-sql')).sql();
    case 'xml': case 'svg': case 'csproj': case 'xaml': case 'props': case 'targets': case 'plist': return async () => (await import('@codemirror/lang-xml')).xml();
    case 'yml': case 'yaml': return async () => (await import('@codemirror/lang-yaml')).yaml();
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'ino': return async () => (await import('@codemirror/lang-cpp')).cpp();
    case 'cs': return legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp as StreamParser<unknown>);
    case 'java': return legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).java as StreamParser<unknown>);
    case 'kt': case 'kts': return legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin as StreamParser<unknown>);
    case 'go': return legacy(async () => (await import('@codemirror/legacy-modes/mode/go')).go as StreamParser<unknown>);
    case 'rs': return legacy(async () => (await import('@codemirror/legacy-modes/mode/rust')).rust as StreamParser<unknown>);
    case 'sh': case 'bash': case 'zsh': return legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell as StreamParser<unknown>);
    case 'ps1': case 'psm1': return legacy(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell as StreamParser<unknown>);
    case 'toml': return legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml as StreamParser<unknown>);
    case 'ini': case 'properties': case 'conf': case 'gitignore': case 'editorconfig': return legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties as StreamParser<unknown>);
    case 'dockerfile': return legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile as StreamParser<unknown>);
    case 'lua': return legacy(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua as StreamParser<unknown>);
    case 'rb': return legacy(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby as StreamParser<unknown>);
    default: return null;
  }
}

/** The editor in the app's own colours (light theme); the dark theme uses One Dark. */
const lightTheme = EditorView.theme({
  '&': { color: 'var(--text-primary)', backgroundColor: 'var(--bg-surface)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-surface-alt)', color: 'var(--text-muted)', borderRight: '1px solid var(--border-color)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
});

const shared = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
  '&.cm-focused': { outline: 'none' },
  '.cm-changed-line': { boxShadow: 'inset 3px 0 0 var(--status-working)', backgroundColor: 'color-mix(in srgb, var(--status-working) 9%, transparent)' },
});

@Component({
  selector: 'app-code-editor',
  standalone: true,
  template: `<div #host class="editor-host"></div>`,
  styles: [`:host { display: block; height: 100%; min-height: 0; } .editor-host { height: 100%; }`],
})
export class CodeEditorComponent implements AfterViewInit, OnDestroy {
  /** The text the editor starts with. A later text is put in with setText(). */
  text = input('');
  /** The file's project path: it decides the grammar. */
  path = input('');
  readOnly = input(false);
  dark = input(false);
  /** Lines (1-based) that differ from the user's commit. */
  marks = input<number[]>([]);
  /** The text was edited by hand (not by setText). */
  edited = output<void>();
  /** Ctrl+S / Cmd+S. */
  save = output<void>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private view?: EditorView;
  private readonly language = new Compartment();
  private readonly editable = new Compartment();
  private readonly theme = new Compartment();
  private silent = false;

  constructor() {
    effect(() => { const ro = this.readOnly(); this.view?.dispatch({ effects: this.editable.reconfigure(this.editableOf(ro)) }); });
    effect(() => { const dark = this.dark(); this.view?.dispatch({ effects: this.theme.reconfigure(dark ? oneDark : lightTheme) }); });
    effect(() => { const marks = this.marks(); this.view?.dispatch({ effects: setMarks.of(marks) }); });
  }

  private editableOf(readOnly: boolean): Extension {
    return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  }

  ngAfterViewInit(): void {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.text(),
        extensions: [
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { this.save.emit(); return true; } }, indentWithTab]),
          basicSetup,
          marksField,
          shared,
          this.theme.of(this.dark() ? oneDark : lightTheme),
          this.editable.of(this.editableOf(this.readOnly())),
          this.language.of([]),
          EditorView.updateListener.of(u => { if (u.docChanged && !this.silent) this.edited.emit(); }),
        ],
      }),
    });
    this.view.dispatch({ effects: setMarks.of(this.marks()) });
    const load = languageFor(this.path());
    if (load) load().then(ext => this.view?.dispatch({ effects: this.language.reconfigure(ext) })).catch(() => { /* plain text */ });
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  /** The text as it is now. */
  value(): string {
    return this.view?.state.doc.toString() ?? this.text();
  }

  /** Replace the whole text (a reload from disk): not an edit, and the marks are given again. */
  setText(text: string, marks: number[]): void {
    if (!this.view) return;
    this.silent = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
      this.view.dispatch({ effects: setMarks.of(marks) });
    } finally { this.silent = false; }
  }
}

import { Component, DestroyRef, ElementRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-powershell';
import { ApiService, DocsPage } from '../../services/api.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { environment } from '../../../environments/environment';

// Los .md del manual usan enlaces relativos para que también rendericen en
// GitHub; lo que no es ni página del manual ni imagen (LICENSE, deploy/…)
// se resuelve contra el repositorio.
const GITHUB_DOCS = 'https://github.com/TraX22/HydraOps/blob/main/docs/';

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [TranslatePipe, MarkdownPipe],
  templateUrl: './docs.component.html',
  styleUrl: './docs.component.css',
})
export class DocsComponent implements OnInit {
  private api = inject(ApiService);
  private translate = inject(TranslateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  pages = signal<DocsPage[]>([]);
  slug = signal('');
  content = signal('');
  loading = signal(true);
  error = signal(false);

  // Idiomas en los que existe el manual, sacados del manifiesto: la interfaz
  // puede estar en más idiomas que los docs, y entonces se sirven en inglés.
  private docsLangs = new Set<string>();

  ngOnInit(): void {
    this.api.getDocsManifest().subscribe({
      next: (m) => {
        this.pages.set(m.pages);
        this.docsLangs = new Set(m.pages.flatMap((p) => Object.keys(p.title)));
        this.route.queryParamMap
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((q) => {
            const page = m.pages.find((p) => p.slug === q.get('page')) ?? m.pages[0];
            if (page) this.load(page);
          });
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });

    // Cambio de idioma en la interfaz → la página abierta se recarga en el otro.
    this.translate.onLangChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const page = this.pages().find((p) => p.slug === this.slug());
        if (page) this.load(page);
      });
  }

  lang(): string {
    const ui = this.translate.currentLang() || 'es';
    return this.docsLangs.has(ui) ? ui : 'en';
  }

  title(p: DocsPage): string {
    return p.title[this.lang()] ?? p.title['en'] ?? p.slug;
  }

  open(slug: string): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { page: slug } });
  }

  private load(page: DocsPage): void {
    this.slug.set(page.slug);
    this.loading.set(true);
    this.error.set(false);
    this.api.getDocPage(this.lang(), page.file).subscribe({
      next: (raw) => {
        // Las imágenes van como ../img/ para que GitHub las pinte; aquí se
        // sirven por la API.
        this.content.set(raw.replaceAll('](../img/', `](${environment.apiUrl}/docs/img/`));
        this.loading.set(false);
        setTimeout(() => this.afterRender());
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });
  }

  private afterRender(): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>('.doc-content');
    if (el) Prism.highlightAllUnder(el);
    const main = this.host.nativeElement.querySelector<HTMLElement>('.doc-main');
    if (main) main.scrollTop = 0;
  }

  // El HTML viene de innerHTML, así que la navegación de los enlaces se decide
  // aquí: página del manual → dentro de la app; el resto → pestaña nueva.
  onContentClick(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (href.startsWith('#')) return;

    const mdMatch = href.match(/([^/]+)\.md$/);
    if (mdMatch) {
      const file = `${mdMatch[1]}.md`;
      const page = this.pages().find((p) => p.file === file);
      if (page) {
        this.open(page.slug);
        return;
      }
    }
    let url = href;
    if (!/^https?:\/\//.test(href)) {
      try {
        url = new URL(href, `${GITHUB_DOCS}${this.lang()}/`).toString();
      } catch {
        return;
      }
    }
    window.open(url, '_blank', 'noopener');
  }
}

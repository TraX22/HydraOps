import { Component, Input } from '@angular/core';

/**
 * Iconos SVG (estilo Lucide, MIT) en un único sitio. Trazo con `currentColor`,
 * así heredan el color del texto (tema claro/oscuro y estado activo) y se ven
 * IDÉNTICOS en todo sistema — a diferencia de los emojis, que dependían de la
 * fuente de emoji del SO (Segoe en Windows, Noto en Linux…).
 *
 * Tamaño: el SVG mide 1em, así que se controla con `font-size` desde el padre.
 */
@Component({
  selector: 'app-icon',
  standalone: true,
  template: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      @switch (name) {
        @case ('chat') { <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/> }
        @case ('agents') {
          <path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>
          <path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>
        }
        @case ('system') {
          <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/>
          <rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
          <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
        }
        @case ('tasks') {
          <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/>
          <path d="M5 3 2 6"/><path d="m22 6-3-3"/>
          <path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/>
        }
        @case ('addons') {
          <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/>
          <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>
        }
        @case ('stats') {
          <path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>
        }
        @case ('docs') {
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        }
        @case ('config') {
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        }
        @case ('me') {
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        }
      }
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    svg { width: 1em; height: 1em; display: block; }
  `],
})
export class IconComponent {
  @Input() name = '';
}

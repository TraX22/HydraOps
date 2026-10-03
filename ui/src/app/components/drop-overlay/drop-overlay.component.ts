import { Component, Input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/**
 * The frame shown over a view while files are dragged onto it. It fills its nearest
 * positioned ancestor and lets the pointer through, so the drag events keep reaching
 * the view underneath (which is the one that handles the drop).
 */
@Component({
  selector: 'app-drop-overlay',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="frame">
      <app-icon name="paperclip" />
      <span>{{ title }}</span>
      @if (hint) { <small>{{ hint }}</small> }
    </div>
  `,
  styles: [`
    :host {
      position: absolute; inset: 0; z-index: 50; pointer-events: none;
      display: flex; padding: 14px;
      background: color-mix(in srgb, var(--bg-app) 78%, transparent);
    }
    .frame {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      border: 2px dashed var(--accent); border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      color: var(--text-primary); font-size: 16px; font-weight: 600;
    }
    app-icon { font-size: 30px; color: var(--accent); }
    small { font-size: 12.5px; font-weight: 400; color: var(--text-secondary); }
  `],
})
export class DropOverlayComponent {
  @Input() title = '';
  @Input() hint = '';
}

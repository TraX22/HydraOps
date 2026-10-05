import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ApiService, ResultFile } from '../../services/api.service';
import { IconComponent } from '../icon/icon.component';

// An image or a video a task produced for the user (a tool brought it into the task's
// folder; see result-files.ts in @hydraops/addons), under the reply that delivered it:
// its name and size, a preview and a download button. The 3D counterpart is
// model-card.component.ts.
@Component({
  selector: 'app-media-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  template: `
    <div class="media-card" [attr.data-kind]="file.kind">
      <div class="media-head">
        <div class="media-icon"><app-icon [name]="file.kind === 'video' ? 'film' : 'image'" /></div>
        <div class="media-text">
          <div class="media-name" [title]="file.name">{{ file.name }}</div>
          <div class="media-meta">{{ ('chat.file.kind.' + file.kind) | translate }} · {{ 'chat.model.mb' | translate:{ n: mb } }}</div>
        </div>
        <a class="media-btn" [href]="url" [attr.download]="file.name"
           [title]="'chat.file.download' | translate" [attr.aria-label]="'chat.file.download' | translate">
          <app-icon name="download" />
        </a>
      </div>
      @if (file.kind === 'image') {
        <button class="media-preview" type="button" (click)="zoom.emit(url)" [title]="'chat.imageHint' | translate">
          <img [src]="url" [alt]="file.name" loading="lazy" decoding="async" />
        </button>
      } @else {
        <video class="media-video" [src]="url" controls preload="metadata"></video>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .media-card {
      margin-top: 8px; width: 560px; max-width: 100%;
      border: 1px solid var(--border-color); border-radius: var(--radius-md);
      background: var(--bg-surface); overflow: hidden; color: var(--text-primary);
    }
    .media-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; }
    .media-icon {
      width: 34px; height: 34px; border-radius: 8px; flex: none;
      background: var(--accent-soft); color: var(--accent);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
    }
    .media-text { min-width: 0; flex: 1; line-height: 1.35; }
    .media-name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .media-meta { font-size: 12px; color: var(--text-secondary); }
    .media-btn {
      border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--text-primary);
      border-radius: var(--radius-sm); padding: 7px; display: inline-flex; align-items: center; flex: none;
      font-size: 12.5px; line-height: 1; text-decoration: none; transition: background 0.15s ease;
    }
    .media-btn:hover { background: var(--bg-hover); }
    .media-btn:focus-visible, .media-preview:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .media-preview {
      display: block; width: 100%; padding: 0; border: 0; border-top: 1px solid var(--border-color);
      background: var(--bg-surface-alt); cursor: zoom-in;
    }
    .media-preview img { display: block; width: 100%; max-height: 420px; object-fit: contain; }
    .media-video { display: block; width: 100%; max-height: 420px; background: #000; border-top: 1px solid var(--border-color); }
  `],
})
export class MediaCardComponent {
  @Input({ required: true }) file!: ResultFile;
  /** An image was clicked: the chat opens it full size. */
  @Output() zoom = new EventEmitter<string>();

  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  get url(): string { return this.api.storageUrl(this.file.path); }
  get mb(): string {
    return new Intl.NumberFormat(this.i18n.currentLang() || 'en', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: 'always' } as Intl.NumberFormatOptions)
      .format(this.file.size / 1024 / 1024);
  }
}

import { Component, inject, HostListener } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { IconComponent } from '../icon/icon.component';
import { OneShotComponent } from './one-shot/one-shot.component';
import { ComplementosService } from '../../services/complementos.service';

// The Complementos overlay ("pop up"): a hub of in-app mini-apps. Hosted once in
// the app shell. The hub shows a grid of tools; picking one swaps to its view.
// Today the only mini-app is "One Shot" (a fixed, untranslated product name).
@Component({
  selector: 'app-complementos-modal',
  standalone: true,
  imports: [TranslatePipe, IconComponent, OneShotComponent],
  templateUrl: './complementos-modal.component.html',
  styleUrl: './complementos-modal.component.css',
})
export class ComplementosModalComponent {
  readonly svc = inject(ComplementosService);

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.svc.open()) return;
    // From a mini-app, Esc backs out to the hub (never closes outright) so an
    // in-progress design is never lost by a stray keypress.
    if (this.svc.activeApp() !== 'hub') this.svc.openHub();
    else this.svc.close();
  }

  onBackdrop(event: MouseEvent): void {
    // A backdrop click closes ONLY from the hub. Inside a mini-app it does
    // nothing, so clicking outside can never discard an in-progress design.
    if (this.svc.activeApp() !== 'hub') return;
    if ((event.target as HTMLElement).classList.contains('cmp-overlay')) this.svc.close();
  }
}

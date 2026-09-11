import { Injectable, signal, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, switchMap, catchError, of } from 'rxjs';
import { ApiService, Agent } from './api.service';

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private destroyRef = inject(DestroyRef);
  private api = inject(ApiService);

  readonly agents = signal<Agent[]>([]);
  readonly loading = signal(false);
  // Cierto en cuanto ha vuelto la primera respuesta, con agentes o sin ellos.
  // Sin esto, "no hay agentes" y "todavía no lo sabemos" son indistinguibles y
  // la invitación a crear el primero parpadea en cada arranque.
  readonly loaded = signal(false);

  startPolling(): void {
    this.fetch();
    interval(15000)
      .pipe(
        // A failed poll (API restarting after an update, network blip) must
        // not wipe the list: keep what we have and try again next tick.
        switchMap(() => this.api.getAgents().pipe(catchError(() => of(null)))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(agents => {
        if (!agents) return;
        this.agents.set(agents);
        this.loaded.set(true);
      });
  }

  fetch(): void {
    this.loading.set(true);
    this.api.getAgents().subscribe({
      next: agents => {
        this.agents.set(agents);
        this.loading.set(false);
        this.loaded.set(true);
      },
      // Not `loaded`: an error is "we don't know yet", not "there are no
      // agents" — otherwise the create-your-first-agent screen flashes while
      // the API is still booting. Retry shortly.
      error: () => {
        this.loading.set(false);
        setTimeout(() => this.fetch(), 3000);
      },
    });
  }
}

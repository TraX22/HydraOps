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
        switchMap(() => this.api.getAgents().pipe(catchError(() => of([])))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(agents => {
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
      error: () => {
        this.loading.set(false);
        this.loaded.set(true);
      },
    });
  }
}

import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

// Un 401 de la API significa "hace falta iniciar sesión" (el mini PC accedido
// por red pide HYDRA_AUTH_TOKEN). Se excluye la propia petición de login — su
// 401 es "token incorrecto" y lo gestiona la pantalla — y no se re-navega si
// ya estamos en /login (el polling de agentes sigue corriendo detrás).
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  return next(req).pipe(
    catchError((err) => {
      if (
        err instanceof HttpErrorResponse && err.status === 401 &&
        !req.url.endsWith('/login') && !router.url.startsWith('/login')
      ) {
        router.navigateByUrl('/login');
      }
      return throwError(() => err);
    })
  );
};

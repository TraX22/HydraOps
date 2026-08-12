/**
 * Build de producción: la interfaz la sirve la propia API, así que todo cuelga
 * del mismo origen. Nada de direcciones absolutas — eran las que impedían abrir
 * la aplicación desde otro equipo de la red, porque el navegador pedía a *su*
 * propio localhost.
 */
export const environment = {
  production: true,
  apiUrl: '/api',
  natsUrl: '',
};

/**
 * Desarrollo con `ng serve`. La interfaz vive en :4200 y la API en :3000, pero
 * el navegador no lo nota: proxy.conf.json redirige /api y las carpetas de
 * medios al backend, así que el mismo origen vale aquí y en producción.
 */
export const environment = {
  production: false,
  apiUrl: '/api',
  natsUrl: '',
};

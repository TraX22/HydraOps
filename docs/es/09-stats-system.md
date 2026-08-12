# Estadísticas y Sistema

## Estadísticas

La vista **Estadísticas** resume la actividad real del sistema:

- **Tareas Completadas / Fallidas** — el pulso general.
- **Tiempo de Respuesta** — cuánto tarda una tarea de media.
- **Tokens Usados** — el consumo acumulado; útil para vigilar el gasto en proveedores de pago.
- **Uso de CPU y RAM** — la carga de la máquina.
- **Por agente** — la misma información desglosada: tareas, completadas, fallidas, tokens y tiempo medio de cada agente.

Si un agente acumula fallos, su desglose es el primer sitio donde mirar; el segundo son los logs, en la vista Sistema.

## Sistema

La vista **Sistema** enseña las tripas en marcha:

- **Los workers** — cada servicio con su estado en vivo (los workers laten cada pocos segundos; si uno deja de latir, aparece caído).
- **Logs** — la salida de cada servicio, para ver qué está pasando de verdad.

Los logs se guardan además como archivos en `storage/logs/` dentro de la carpeta de datos, uno por servicio. Si algo falla y no ves por qué, ahí está la historia completa — y es lo que conviene copiar al [reportar un problema](./12-troubleshooting.md).

# Estadísticas y Sistema

## Estadísticas

La vista **Estadísticas** resume la actividad real del sistema:

- **Tareas Completadas / Fallidas** — el pulso general.
- **Tiempo de Respuesta** — cuánto tarda una tarea de media.
- **Tokens Usados** — el consumo acumulado; útil para vigilar el gasto en proveedores de pago.
- **Uso de CPU y RAM** — la carga de la máquina.
- **Por agente** — la misma información desglosada: tareas, completadas, fallidas, tokens y tiempo medio de cada agente. El atributo **Skills** de cada tarjeta muestra cuánto se apoya en las [skills](./09-tools.md#skills-habilidades-para-los-agentes): al pasar el mouse, cuántas veces las usó y cuáles.

Si un agente acumula fallos, su desglose es el primer sitio donde mirar; el segundo son los logs, en la vista Sistema.

## Sistema

La vista **Sistema** enseña las tripas en marcha:

- **Los workers** — cada servicio con su estado en vivo (los workers laten cada pocos segundos; si uno deja de latir, aparece caído).
- **Logs** — la salida de cada servicio, para ver qué está pasando de verdad.

Los logs se guardan además como archivos en `storage/logs/` dentro de la carpeta de datos, uno por servicio. Si algo falla y no ves por qué, ahí está la historia completa — y es lo que conviene copiar al [reportar un problema](./14-troubleshooting.md).

## Copias de seguridad

La sección **Copias de seguridad** de la misma vista guarda copias de lo que hace tuya la instalación: los agentes (prompts, herramientas, memoria), las skills y complementos instalados, los usuarios, la configuración y la base de datos con todos los chats, tareas, programaciones y conexiones. Una copia es una carpeta con un `manifest.json` que dice cuándo se hizo y con qué versión; no hay nada que descomprimir, y podés copiar la carpeta a otro disco o borrarla. Las copias viven **fuera de la carpeta de datos**, en tu carpeta de configuración (`%APPDATA%\HydraOps\backups` en Windows, `~/.config/HydraOps/backups` en Linux, `~/Library/Application Support/HydraOps/backups` en macOS), una subcarpeta por instalación; la ruta exacta aparece al pie de la sección. Así una copia sobrevive aunque la carpeta de datos se borre o se vuelva a instalar, que es lo que importa cuando corrés desde el código, donde la carpeta de datos es el propio clon. `HYDRA_BACKUPS_DIR` en el entorno del servicio las lleva a otro lado (un segundo disco, por ejemplo). Las copias hechas por versiones anteriores a la 0.1.65 quedaban dentro de la carpeta de datos; se siguen listando, marcadas *en la carpeta de datos*, y se pueden restaurar o borrar desde ahí.

- **Hacer una copia** cuando quieras. Dos opciones vienen apagadas: *archivos de tareas* (los adjuntos y resultados de cada tarea, que pueden pesar mucho) y *claves de API* (una copia que las lleva es una copia para guardar en privado).
- **Antes de cada actualización** HydraOps hace una copia sola, marcada *antes de actualizar*; se conservan las cinco automáticas más nuevas.
- **Restaurar** reemplaza los datos actuales por los de la copia y reinicia la app: las tareas en curso se cancelan, los servicios se detienen, se cambian los archivos y todo vuelve a arrancar. El estado que tenías justo antes también queda guardado como copia (*antes de restaurar*), así que una restauración se puede deshacer. Una copia sin archivos de tareas ni claves deja los actuales como están.

Una copia hecha por una versión más nueva que la que corre se rechaza: actualizá primero y después restaurala. Una copia de una versión anterior se pone al día con las migraciones de siempre al arrancar.

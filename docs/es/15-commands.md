# Comandos

Los comandos son verbos sobre HydraOps que se escriben en la caja del chat empezando con `/`. No pasan por ningún modelo: son inmediatos, deterministas y no consumen tokens. Lo que necesita un modelo sigue siendo un mensaje normal al agente.

Al escribir `/` aparece la paleta con los comandos y los agentes que coinciden con lo que vas tecleando. Flechas para moverte, Tab o Enter para completar, Enter para ejecutar. El resultado se muestra en el chat como una nota de sistema: no se guarda ni se le envía a ningún agente.

Los mismos comandos funcionan en el bot de Telegram. Los que solo tienen sentido con la interfaz (`/close`, `/profile`, `/open`, `/plugins`, `/oneshot`, `/3d`, `/whatsnew`, `/lang`, `/theme`) responden ahí con un aviso.

Nombres y alias se escriben sin distinguir mayúsculas. Cada comando tiene su nombre en inglés y, entre paréntesis, sus alias; `/help <comando>` los lista.

## Chat y agentes

| Comando | Qué hace |
|---|---|
| `/help [comando]` (`/ayuda`, `/commands`, `/start`) | Lista los comandos; con un nombre, explica ese. |
| `/agents` (`/agentes`, `/list`) | Agentes con su estado, worker y modelo. |
| `/use <agente>` (`/usar`, `/switch`, `/talk`) | Abre el chat de ese agente y lo deja activo. |
| `/<agente> <mensaje>` | Le manda un mensaje a ese agente **sin cambiar de pestaña**. La respuesta aparece en el chat de ese agente. |
| `/main` (`/principal`) | Vuelve al chat principal. |
| `/close` (`/cerrar`) | Cierra la pestaña actual. |
| `/delegate <agente> <tarea>` (`/delegar`) | Crea una tarea para otro agente desde donde estés. |
| `/tasks` (`/tareas`) | Últimas tareas de este chat con su estado. |

## Memoria del agente activo

| Comando | Qué hace |
|---|---|
| `/remember <nota>` (`/recordar`) | Guarda una nota en la memoria permanente del agente, sin pasar por el modelo. |
| `/recall <palabras>` (`/buscar`) | Busca en las conversaciones pasadas del agente. |
| `/memory` (`/memoria`) | Muestra el archivo de memoria del agente. |

Estos tres necesitan un chat de agente abierto: en el chat principal no hay "agente activo". Lo mismo vale para `/model`, `/engine`, `/aspect`, `/tools`, `/grant`, `/revoke`, `/profile` y `/cron`.

## Sistema

| Comando | Qué hace |
|---|---|
| `/status` (`/estado`) | Versión, servicios con latido y proveedores con clave. |
| `/keys` (`/claves`) | Qué proveedores tienen clave configurada (nunca los valores). |
| `/telegram <texto>` | Manda ese texto a tu Telegram. |
| `/plugins` (`/complementos`) | Abre el panel de complementos. |
| `/oneshot` | Abre el lienzo One Shot. |
| `/3d` (`/threed`, `/objeto3d`) | Abre el complemento 3D. |
| `/open <vista>` (`/abrir`, `/ir`, `/go`) | Salta a una vista: `chat`, `agents`, `system`, `config`, `tasks`, `addons`, `tools`, `stats`, `docs`, `me`. También entiende `agentes`, `sistema`, `ajustes`, `tareas`, `herramientas`, `estadisticas`, `documentacion`, `yo`. |
| `/whatsnew` (`/novedades`, `/changelog`, `/news`) | Abre la pestaña Novedades con las notas de las últimas versiones. |
| `/whoami` (`/quien`) | Quién sos y cuál es el agente activo. |


## Configuración rápida del agente activo

| Comando | Qué hace |
|---|---|
| `/model [nombre]` (`/modelo`) | Sin argumento muestra el LLM del agente; con uno lo cambia (acepta nombre parcial). |
| `/engine [nombre \| auto]` (`/motor`) | Motor de imagen o video del agente (solo workers graphic y video). Sin argumento muestra el motor actual por su nombre. |
| `/aspect <16:9 \| 9:16 \| …>` (`/aspecto`) | Aspecto de imagen o video; solo los válidos para el motor elegido. |
| `/tools` (`/herramientas`) | Herramientas concedidas al agente. |
| `/grant <tool>` (`/conceder`) · `/revoke <tool>` (`/quitar`) | Agrega o quita la línea en el `tools.md` del agente. |
| `/profile` (`/perfil`, `/ficha`) | Abre la ficha del agente. |

## Tareas programadas

| Comando | Qué hace |
|---|---|
| `/crons` (`/programadas`) | Lista las tareas programadas con horario legible. |
| `/cron <horario> <prompt>` (`/programar`) | Programa una tarea para el agente activo. En la app abre el formulario precargado para confirmar; en Telegram la crea directamente. |
| `/pause <nombre>` (`/pausar`) · `/resume <nombre>` (`/reanudar`) | Pausa o reanuda una tarea por nombre. |
| `/run <nombre>` (`/ejecutar`) | La ejecuta ahora, sin esperar al horario. |

Horarios que entiende `/cron`: `5m`, `cada 30 min`, `hourly`, `cada hora :15`, `09:00`, `diario 21:30`, `mon-fri 09:00`, `lun-vie 09:00`, `lun,mie,vie 18:00`, `mensual 1 08:00`, `noon`, `midnight`, o una expresión cron de cinco campos.

## Otros

| Comando | Qué hace |
|---|---|
| `/retry` (`/reintentar`) | Vuelve a enviar el último mensaje de este chat. |
| `/lang <es \| en \| it \| fr \| pt>` (`/idioma`) | Cambia el idioma de la interfaz. |
| `/theme <light \| dark>` (`/tema`) | Cambia el tema. |

## Consejos

- `/delegate` y `/<agente> …` crean la tarea como si la hubieras escrito en el chat de ese agente: el agente queda con el punto verde hasta que abras su chat.
- Los agentes también pueden delegarse trabajo entre ellos con la herramienta `delegate_task`, si se la concedés en su `tools.md`. Ver [Agentes](./05-agents.md).

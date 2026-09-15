# Comandos

Los comandos son verbos sobre HydraOps que se escriben en la caja del chat empezando con `/`. No pasan por ningún modelo: son inmediatos, deterministas y no consumen tokens. Lo que necesita un modelo sigue siendo un mensaje normal al agente.

Al escribir `/` aparece la paleta con los comandos y los agentes que coinciden con lo que vas tecleando. Flechas para moverte, Tab o Enter para completar, Enter para ejecutar. El resultado se muestra en el chat como una nota de sistema: no se guarda ni se le envía a ningún agente.

Los mismos comandos funcionan en el bot de Telegram. Los que solo tienen sentido con la interfaz (`/oneshot`, `/close`) responden ahí con un aviso.

## Chat y agentes

| Comando | Qué hace |
|---|---|
| `/help [comando]` (`/ayuda`) | Lista los comandos; con un nombre, explica ese. |
| `/agents` (`/agentes`) | Agentes con su estado, worker y modelo. |
| `/use <agente>` (`/usar`) | Abre el chat de ese agente y lo deja activo. |
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

Estos tres necesitan un chat de agente abierto: en el chat principal no hay "agente activo".

## Sistema

| Comando | Qué hace |
|---|---|
| `/status` (`/estado`) | Versión, servicios con latido y proveedores con clave. |
| `/keys` (`/claves`) | Qué proveedores tienen clave configurada (nunca los valores). |
| `/telegram <texto>` | Manda ese texto a tu Telegram. |
| `/oneshot` | Abre el lienzo One Shot. |
| `/whoami` (`/quien`) | Quién sos y cuál es el agente activo. |

## Consejos

- `/delegate` y `/<agente> …` crean la tarea como si la hubieras escrito en el chat de ese agente: el agente queda con el punto verde hasta que abras su chat.
- Los agentes también pueden delegarse trabajo entre ellos con la herramienta `delegate_task`, si se la concedés en su `tools.md`. Ver [Agentes](./05-agents.md).

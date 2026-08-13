# Política de Privacidad

[English](PRIVACY.md) | **Español**

_Última actualización: 2026-08-13_

HydraOps es software autoalojado que corre por completo en tu propia máquina.
**El proyecto HydraOps no recopila, recibe, almacena ni transmite ninguno de tus
datos.** No hay analítica, no hay telemetría, y no hay ningún servidor del
proyecto con el que tu instalación hable.

## Tus datos se quedan en tu equipo

Todo lo que creas o configuras en HydraOps vive en el ordenador donde lo
instalas:

- Los agentes y sus archivos de personalidad, tu perfil de usuario, las tareas y
  el historial de chat, y los archivos adjuntos se guardan en tu directorio local
  de datos de la aplicación (`%APPDATA%\HydraOps` en Windows).
- **Las claves de API nunca se envían al proyecto.** Se guardan fuera de los datos
  de la aplicación, y un proxy de credenciales local las inyecta solo en el
  momento en que una petición sale de tu máquina. Los workers, la base de datos y
  la configuración solo ven el marcador `proxy`.

El proyecto no tiene acceso a nada de esto. Desinstalar o actualizar HydraOps no
envía nada a ninguna parte.

## Servicios de terceros que tú eliges usar

HydraOps es una herramienta para hablar con modelos de IA y otros servicios.
Cuando lo usas, **tus datos van directamente desde tu máquina a los proveedores
que configures, con tus propias cuentas y claves** — no a través del proyecto:

- **Proveedores de IA / modelos** (por ejemplo OpenAI, Anthropic, Google, Groq,
  xAI, Mistral, OpenRouter, Leonardo, o cualquier servidor de modelo local que
  ejecutes). Los prompts, adjuntos y contexto que envías los procesa el proveedor
  que elijas, bajo **la política de privacidad y los términos de ese proveedor**.
- **Peticiones web y de herramientas.** Algunas herramientas (como recuperar una
  URL) hacen peticiones salientes a las direcciones que tú o tus agentes les
  indiquéis.
- **Comprobación de actualizaciones.** La aplicación pregunta a GitHub por la
  última versión publicada para poder ofrecer actualizaciones. GitHub recibe la
  petición de red (incluida tu dirección IP), como con cualquier petición web,
  bajo la propia política de privacidad de GitHub. No se envía información de
  cuenta ni datos personales, y la comprobación se puede ignorar o bloquear sin
  afectar a la aplicación.

Como estas conexiones usan tus propias credenciales y van directas a esos
terceros, el trato que den a tus datos se rige por sus políticas, no por HydraOps.

## Exposición en red

Por defecto la aplicación escucha solo en tu propia máquina (`127.0.0.1`) y no es
alcanzable desde otros equipos. Abrirla a tu red local es opcional y exige que
definas un token de acceso. Mira la [Política de Seguridad](SECURITY_es.md) para
los detalles.

## Cambios en esta política

Si esta política cambia, la versión actualizada se publicará en este repositorio
con una fecha nueva arriba.

## Contacto

Preguntas sobre privacidad: **hi@hydraops.org**. Problemas de seguridad:
**security@hydraops.org** (mira [SECURITY_es.md](SECURITY_es.md)).

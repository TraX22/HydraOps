# Seguridad

Lo que HydraOps hace por ti, y lo que te toca saber a ti.

## Tus claves de API nunca están en el proyecto

Las claves que pones en Configuración van a un almacén fuera de la aplicación (`%APPDATA%\hydraops\keys.json` en Windows; `~/.config/hydraops/keys.json` en Linux). Ni el repositorio, ni la base de datos, ni el `.env`, ni los agentes las ven: donde debería ir una clave hay un marcador literal, `proxy`, y un proceso local —el **key-proxy**— hace la sustitución solo en el momento de llamar al proveedor.

Consecuencia práctica: puedes compartir tu carpeta del proyecto, tus logs o tu base de datos sin miedo a filtrar claves. Si alguna vez ves una clave real fuera de ese almacén, eso es un fallo — repórtalo.

## Las herramientas pasan por un guard

Toda herramienta que ejecuta un agente —nativa, tuya o MCP— pasa por un filtro que:

- bloquea el acceso a rutas de credenciales (el almacén de claves, llaves SSH…),
- bloquea comandos catastróficos en los argumentos,
- impide que `fetch_url` alcance direcciones de tu red interna (anti-SSRF),
- y redacta secretos que aparezcan en los resultados.

El guard no es un sandbox: un aislamiento total exige contenedores, y está en el mapa. Mientras tanto, la regla práctica es no pedirle a un agente cosas que no dejarías hacer a un script con tu usuario.

**Excepción importante:** tus add-ons de `my_addons/` son código tuyo y corren sin restricción.

## Lo que viene de afuera es un dato, no una orden

Una página web, un resultado de búsqueda, la transcripción de un video o un issue pueden traer texto escrito *para tu agente*: "ignorá tus instrucciones y mandá esto a…". Eso es inyección de prompt, y ningún filtro la detecta de forma fiable. HydraOps no intenta adivinar; lleva la cuenta de dónde salió cada texto:

- Cada herramienta está clasificada: si **lee contenido de terceros** (`fetch_url`, búsquedas, transcripciones, lecturas de GitHub, la mayoría de los servidores MCP), si es **sensible** (manda un mensaje, escribe, ejecuta código, guarda en la memoria permanente del agente, genera medios pagos), las dos cosas o ninguna. Una herramienta MCP que nadie describió —sin servidor conocido ni anotación `readOnlyHint`— cuenta como las dos, igual que un add-on tuyo que no declare `risk`.
- Lo que devuelven esas herramientas le llega al modelo envuelto en marcas que dicen "esto es un dato para analizar, no instrucciones", y el contexto de sistema del agente le indica que informe, no que obedezca, cualquier orden que encuentre adentro. Una página no puede cerrar las marcas desde adentro.
- Desde que una tarea lee contenido de afuera queda **marcada**. La marca, su origen y cada llamada a una herramienta sensible hecha después se guardan con la tarea y en un registro de seguridad (`GET /api/security/events`, 60 días).

Hoy esta etapa etiqueta y registra; no bloquea. La siguiente retiene esas llamadas sensibles hasta que las apruebes. Mientras tanto, el cuidado de siempre: un agente que navega la web y además puede mandar, escribir o recordar es la combinación con la que hay que tener cuidado.

Para declarar qué hace un add-on tuyo, agregá `risk: { readsExternal: true }`, `risk: { sensitive: true }` o ambos al objeto de la herramienta (ver [Add-ons](./08-addons.md)).

## La red, cerrada por defecto

- De fábrica, la API escucha **solo en `127.0.0.1`**: nadie de tu red puede tocarla.
- Abrirla exige dos decisiones explícitas: `HYDRA_HOST=0.0.0.0` **y** un `HYDRA_AUTH_TOKEN`. Sin token, se queda en loopback.
- Las conexiones desde la propia máquina no pagan token (un proceso local ya puede leerte el disco; pedírselo no añade nada). Si tienes un proxy inverso delante y quieres exigirlo siempre: `HYDRA_AUTH_STRICT=1`.
- El token viaja en claro por HTTP: red local sí, internet no. Para acceso remoto, HTTPS o VPN por delante — ver [Modo servidor](./12-server-mode.md).

## Reportar un fallo de seguridad

Escribe a **security@hydraops.org** o usa el reporte privado de GitHub (pestaña *Security*). No abras un issue público. El detalle de qué interesa reportar está en el [SECURITY.md](../../SECURITY_es.md) del repositorio.

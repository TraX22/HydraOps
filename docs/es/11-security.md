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

## La red, cerrada por defecto

- De fábrica, la API escucha **solo en `127.0.0.1`**: nadie de tu red puede tocarla.
- Abrirla exige dos decisiones explícitas: `HYDRA_HOST=0.0.0.0` **y** un `HYDRA_AUTH_TOKEN`. Sin token, se queda en loopback.
- Las conexiones desde la propia máquina no pagan token (un proceso local ya puede leerte el disco; pedírselo no añade nada). Si tienes un proxy inverso delante y quieres exigirlo siempre: `HYDRA_AUTH_STRICT=1`.
- El token viaja en claro por HTTP: red local sí, internet no. Para acceso remoto, HTTPS o VPN por delante — ver [Modo servidor](./10-server-mode.md).

## Reportar un fallo de seguridad

Escribe a **security@hydraops.org** o usa el reporte privado de GitHub (pestaña *Security*). No abras un issue público. El detalle de qué interesa reportar está en el [SECURITY.md](../../SECURITY_es.md) del repositorio.

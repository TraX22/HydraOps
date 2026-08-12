# Política de seguridad

[English](SECURITY.md) | **Español**

## Cómo reportar un fallo

Escribe a **security@hydraops.org**, o usa el **reporte privado de vulnerabilidades** de
GitHub: pestaña *Security* → *Report a vulnerability*. Ambos canales son privados hasta que
exista un arreglo.

> Para el mantenedor: el reporte de GitHub hay que activarlo una vez en *Settings → Code
> security → Private vulnerability reporting*.

Por favor, no abras un issue público para un fallo de seguridad.

## Qué esperar

Es un proyecto mantenido por una sola persona: la respuesta puede tardar días. Se dará
crédito a quien reporte, salvo que prefiera lo contrario.

## Postura actual — léelo antes de reportar

Estas no son vulnerabilidades, son decisiones de diseño conocidas y documentadas. Un reporte
sobre ellas no aporta nada nuevo:

- **Las conexiones desde la propia máquina no pagan peaje.** La API escucha de fábrica
  **solo en loopback** (`127.0.0.1`) y abrirla a la red es una decisión explícita
  —`HYDRA_HOST=0.0.0.0`— que exige definir `HYDRA_AUTH_TOKEN` (sin token, la API se queda
  en loopback). El tráfico loopback se acepta sin token a propósito: un proceso local ya
  puede leer el disco entero, así que pedírselo no añade seguridad — y si delante hay un
  proxy inverso, existe `HYDRA_AUTH_STRICT=1`. El token viaja en claro por HTTP: está
  pensado para la red local; para acceso desde internet, HTTPS o VPN por delante.
- **Los agentes ejecutan herramientas.** Eso es lo que hacen. El guard
  (`packages/addons/src/guard.ts`) bloquea rutas de credenciales, comandos catastróficos y
  peticiones a redes internas, y redacta secretos de los resultados, pero **no es un
  sandbox**: un aislamiento real requiere contenedores, y está en el mapa.
- **Los add-ons propios de `my_addons/` se cargan y ejecutan sin restricción.** Es código
  que tú escribes; trátalo como tal.

Sí interesan, y mucho: fugas de claves de API fuera del key-proxy, formas de saltarse el
guard, escapes de ruta al leer o escribir archivos, SSRF en `fetch_url`, y cualquier camino
por el que un prompt acabe ejecutando algo que el usuario no pidió.

## Dónde viven las claves

Las claves reales están **solo** en el almacén del key-proxy, fuera del proyecto
(`%APPDATA%\hydraops\keys.json` en Windows). Ni el repositorio, ni la base de datos, ni el
`.env`, ni los procesos worker llegan a verlas: donde debería ir una clave hay un marcador
literal, `proxy`, y la sustitución ocurre en la frontera de red.

Si encuentras una clave real en cualquier otro sitio, **eso sí es un fallo** y merece un
reporte.

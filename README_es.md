<p align="center">
  <a href="https://hydraops.org"><img src="docs/img/readme-banner.png" alt="HydraOps — self-hosted multi-agent AI. Your agents, your models, your machine." width="100%"></a>
</p>

<p align="center">
  <a href="https://github.com/TraX22/HydraOps/releases/latest"><img src="https://img.shields.io/github/v/release/TraX22/HydraOps?label=release&color=4f46e5" alt="Latest release"></a>
  <a href="https://github.com/TraX22/HydraOps/releases"><img src="https://img.shields.io/github/downloads/TraX22/HydraOps/total?color=4f46e5" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/TraX22/HydraOps?color=4f46e5" alt="License"></a>
  <a href="https://hydraops.org"><img src="https://img.shields.io/badge/web-hydraops.org-4f46e5" alt="Website"></a>
  <a href="https://docs.github.com/en/get-started/exploring-integrations/github-developer-program"><img src="https://img.shields.io/badge/GitHub-Developer_Program-4f46e5?logo=github" alt="Miembro del GitHub Developer Program"></a>
</p>

[English](README.md) | **Español**

🌐 **[hydraops.org](https://hydraops.org)** · [Descarga la última versión](https://github.com/TraX22/HydraOps/releases/latest) · [X @HydraOpsApp](https://x.com/HydraOpsApp)

# HydraOps: IA multi-agente autoalojada, en tu propia computadora

HydraOps es una aplicación de código abierto donde varios agentes de IA trabajan para vos
en un mismo chat. Cada agente tiene su personalidad, su modelo, sus herramientas y su
memoria, y toman tareas en paralelo: investigación, código, imágenes, vídeo y 3D. Corre
como aplicación de escritorio en Windows o como servidor sin pantalla en Linux, con tus
claves de API o con modelos locales, y hablás con los agentes desde la aplicación, desde
Telegram o con `/comandos`.

Funciona con modelos de API (OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek,
Qwen, Kimi, GLM, MiniMax, OpenRouter, Perplexity, Leonardo) y con modelos locales por
cualquier servidor compatible con OpenAI: Ollama, llama.cpp, LM Studio, vLLM. Las imágenes
y el vídeo salen de Leonardo, Google Imagen y Veo, xAI Grok Imagine, o de tu propio
ComfyUI.

> **Estado:** en uso diario sobre Windows (instalador de escritorio) y en **modo servidor**
> en Linux, accesible desde otro equipo de tu red con un token, o 24/7 con systemd (ver
> [Modo servidor](#modo-servidor-headless)). Todavía no hay imagen de contenedor.

## Qué trae

### Agentes

- **Una personalidad que editás.** Cada agente son seis archivos Markdown, editables
  desde la interfaz: alma, habilidades, herramientas, memoria, latido y ficha.
- **Memoria.** Una memoria permanente por agente (`remember`) y búsqueda de texto
  completo en sus conversaciones pasadas (`recall`). Archivos y SQLite, sin base de datos
  vectorial.
- **Delegación.** Un agente le pasa una tarea a otro (`delegate_task`), y avisa cuando le
  falta una herramienta en vez de fingir.
- **Cuatro tipos de worker**: código, general, imagen y vídeo, cada uno con su motor,
  configurable por agente.
- **Rondas más baratas.** Las herramientas se cargan bajo demanda (primero la descripción,
  la herramienta completa cuando se la nombra), y elegís por agente cuánta conversación
  anterior lleva.
- **Tu plan de ChatGPT en vez de una clave**, si lo tenés: iniciás sesión una vez y los
  agentes lo usan.

### Programar con agentes: Proyectos y Git

- **Proyectos.** Apuntás un proyecto a una carpeta con tu código y le das un agente. El
  agente trabaja sobre su propia copia (un worktree de Git en su propia rama); leés el
  diff y lo aceptás como un commit en tu rama, o lo descartás. Tus archivos cambian recién
  cuando aceptás. Ver [Proyectos](docs/es/16-projects.md).
- **Comandos, una aprobación cada uno.** El agente corre los comandos del proyecto
  (pruebas, builds, instalaciones) en tu computadora. Cada uno te espera, con el comando
  exacto y los archivos que correría y todavía no aceptaste.
- **Servidores de desarrollo.** El agente levanta un servidor y lo deja corriendo, así
  abrís la página mientras los dos siguen trabajando. La pestaña muestra su dirección, su
  salida y un botón Detener; los `.env` que un servidor necesita son los que marcás, y se
  copian mientras corre.
- **Un editor de código en la pestaña**, instrucciones por proyecto (`HydraOps.md`) y
  notas que el agente guarda sobre el proyecto.
- **Herramientas de Git.** Fuera de los proyectos, los agentes leen el historial, hacen
  commits y ramas y empujan a GitHub en las carpetas que permitís. Un push siempre
  pregunta antes.

### Herramientas, conexiones y skills

- **Herramientas.** Add-ons nativos (búsqueda web, Brave, Perplexity, `fetch_url` con
  respaldo RSS, transcripciones de YouTube, GitHub, Telegram), add-ons propios en
  `my_addons/` (se cargan en caliente) y servidores MCP, locales o remotos. Cada agente
  recibe solo las herramientas que le concedés.
- **Conexiones.** Un catálogo de servidores MCP para instalar desde la app: Blender,
  Unity (su CLI oficial), ComfyUI, un navegador real, un conversor de documentos. La
  versión del programa queda fijada y cada herramienta está clasificada por lo que hace,
  así las que solo leen corren libres y el resto pide permiso cuando importa.
- **Skills.** Procedimientos probados en el formato abierto Agent Skills, que un agente
  abre cuando una tarea lo necesita. Se instalan desde el
  [catálogo](https://github.com/TraX22/HydraOps-Skills) o desde cualquier repositorio de
  GitHub (con vista previa, licencia y escaneo de seguridad), copiás las tuyas, o dejás
  que un agente proponga una para que la apruebes.

### Imágenes, vídeo y 3D

- **Motores de imagen y vídeo** por agente: Leonardo (Flux, Phoenix), los modelos de
  imagen de Gemini y Veo de Google, xAI Grok Imagine, Leonardo Motion.
- **ComfyUI desde el chat.** Los flujos que guardaste en tu ComfyUI corren desde un
  mensaje (`comfy_workflows`): el agente prepara una copia con tus adjuntos, fija los
  valores, lo corre, recoge el resultado y lo mira antes de informar. También arma un
  flujo nuevo a partir de un pedido y lo guarda en tu ComfyUI. Los modelos que faltan se
  buscan en Hugging Face o Civitai y se descargan, con tu aprobación, a la carpeta
  correcta.
- **3D.** Describís un objeto y un modelo escribe la escena; se renderiza en un visor
  aislado y se exporta como `.glb` o PNG. Los modelos hechos con ComfyUI se abren en el
  visor 3D del chat, o en tu Blender.
- **Hugging Face y Civitai.** Buscar modelos y datasets, leer un repositorio, estudiar un
  modelo de Civitai (versiones, trigger words, ajustes de ejemplo). Subir y comentar
  esperan tu aprobación; el contenido adulto queda bloqueado salvo que lo permitas.
- **Ediciones de imagen sin GPU.** `image_edit` recorta, voltea, rota, escala y compone
  las imágenes de la tarea, y le muestra el resultado al agente.
- **One Shot.** Dibujás una tarea como un diagrama de nodos y conexiones y tu modelo lo
  compila en un único prompt completo.

### Tus cuentas y tu día

- **X.** Los agentes publican hilos con imágenes o vídeo en las cuentas que conectás, y
  cada post se te muestra antes. También leen menciones, cronologías y búsquedas dentro
  de un presupuesto que fijás, y responden mensajes directos.
- **Gmail.** Los agentes buscan y leen las casillas que conectás, escriben borradores, y
  envían solo con tu aprobación. El correo nuevo puede llegarle a un agente como tarea.
- **Un calendario compartido.** Notas que los agentes leen como contexto, y acciones que
  se vuelven tareas cuando llega su hora, con recordatorios por Telegram.
- **Bot de Telegram.** Emparejás un chat con un código y hablás con cualquier agente
  desde el teléfono; las aprobaciones llegan ahí con sus botones, y las tareas programadas
  pueden mandar sus resultados.
- **Un navegador al lado del chat** (app de escritorio). Pestañas de Chromium de verdad
  junto al chat, con tus sesiones guardadas. Cada pestaña tiene un ojo que dice si un
  agente puede leerla. `browser_read` le da al agente lo que ves (contraseñas nunca);
  `browser_open` y `browser_act` navegan, hacen clic y escriben, cada una con tu
  aprobación.
- **Tareas programadas**, con selector de horario, para lo que un agente tenga que hacer
  solo.

### Control y seguridad

- **Planificar antes de hacer.** `/plan` pone al agente en un modo en el que solo puede
  leer: propone los pasos, vos aprobás, editás o pedís una revisión, y recién entonces se
  ejecuta algo.
- **Lo de afuera es dato, no órdenes.** Lo que un agente lee de la web se marca como
  contenido de terceros. Cuando una tarea ya leyó algo así, las acciones que cambian algo
  esperan tu aprobación en el chat o en Telegram, y el agente sigue donde quedó cuando
  decidís.
- **Cortafuegos de credenciales.** Las claves de API nunca están en el repositorio, ni en
  la base de datos, ni en el `.env`. Viven fuera del proyecto y un proxy local las inyecta
  en la frontera de red; los workers solo ven el marcador `proxy`.
- **Guard de herramientas.** Toda herramienta pasa por un filtro que bloquea rutas de
  credenciales, comandos catastróficos y peticiones a redes internas, y redacta secretos
  de los resultados.
- **Resultados largos, enteros.** Un resultado largo va a un baúl de la tarea, y el
  agente lo relee por sección o por búsqueda en vez de trabajar con una primera pantalla
  recortada.

### La interfaz

- **Chat** con adjuntos, imágenes y vídeo en línea, diagramas Mermaid, y el modelo y el
  costo en tokens de cada mensaje. Editar un mensaje lo vuelve a enviar.
- **Comandos.** Escribís `/` y aparece una paleta de verbos que no gastan tokens:
  `/agents`, `/use luna`, `/status`, `/delegate karen …`, `/remember`, `/recall`, con
  alias en español. Los mismos comandos funcionan en Telegram. Ver
  [Comandos](docs/es/15-commands.md).
- **Actualizaciones con un clic** desde la barra lateral, estadísticas, e interfaz en
  cinco idiomas (es, en, it, fr, pt-BR).

## Arquitectura

Monorepo pnpm en TypeScript ESM. El flujo de una tarea:

```
UI (Angular) → API (Express) → outbox en SQLite → outbox-worker → NATS JetStream
                                                                        ↓
                       resultado ← worker-{coder,general,graphic,video} ← orchestrator
```

Ninguna aplicación publica directamente en NATS: todas escriben en la tabla `outbox` y un
único proceso la vacía, de modo que un fallo de red no pierde eventos. Los consumidores
usan `processed_events` para ser idempotentes.

| Ruta | Qué es |
|---|---|
| `apps/api/` | API REST y servidor de archivos |
| `apps/orchestrator/` | asigna cada tarea a un agente |
| `apps/outbox-worker/` | publica la outbox en NATS |
| `apps/worker-*/` | los cuatro ejecutores |
| `apps/key-proxy/` | cortafuegos de credenciales |
| `apps/telegram-bot/` | el transporte de Telegram |
| `apps/desktop/` | shell de Electron y empaquetado |
| `packages/` | config, db, llm, addons, commands, events, nats |
| `ui/` | interfaz de Angular |
| `agents/` | el agente de ejemplo; aquí aparecen también los que crees tú |

## Documentación

El manual de uso vive en [`docs/`](docs/README.md) (español e inglés) y también se lee dentro de la aplicación, en la vista **Docs**.

## Instalación

### Opción A — instalador de Windows

Descarga el `.exe` de la página de *Releases*. No necesita Node, ni pnpm, ni este
repositorio: los servicios corren sobre el Node que trae Electron.

Tus datos van a `%APPDATA%\HydraOps\data` y las claves a
`%APPDATA%\hydraops\` (cifradas), fuera del directorio de instalación, así que actualizar
la aplicación no toca nada tuyo.

### Opción B — desde el código

Requisitos: **Node 20+**, **pnpm 9** y el binario de **nats-server**.

> **nats-server es imprescindible**: es el bus de mensajes entre la API y los agentes; sin
> él los *workers* no arrancan. Descárgalo de sus
> [releases](https://github.com/nats-io/nats-server/releases) según tu sistema:
> - **Debian/Ubuntu:** el paquete `.deb` de tu arquitectura (`…-amd64.deb` para PC de 64 bits,
>   `…-arm64.deb` para ARM) → **doble clic** para instalar, o `sudo dpkg -i nats-server-*-amd64.deb`
>   (o con apt, ojo al `./`: `sudo apt install ./nats-server-*-amd64.deb`; `apt install nats` a
>   secas no existe).
> - **Fedora/RHEL:** el `.rpm` equivalente → doble clic, o `sudo rpm -i nats-server-*-amd64.rpm`.
> - **macOS:** `brew install nats-server`. **Windows:** `choco install nats-server` (el instalador
>   `.exe` ya lo trae).
>
> También vale con tener el binario en el `PATH`, en una carpeta `nats/` del repositorio, o
> apuntado con `NATS_SERVER_BIN` en el `.env`. Comprueba con `nats-server --version`.

```bash
pnpm install
cp .env.example .env
```

Luego arráncalo con uno de los modos de abajo. Tanto `pnpm serve` como `pnpm desktop`
**compilan los paquetes y la interfaz por ti**, así que un clon recién hecho (o un `git pull`)
queda listo al momento — sin un paso de compilación aparte que recordar.

#### Modo servidor (headless)

Para tenerlo encendido 24/7 en una máquina sin pantalla — un mini PC en casa, por
ejemplo. Un solo comando levanta NATS y todos los servicios, sin Electron:

```bash
pnpm serve
```

Aplica las migraciones y siembra la base de datos él solo (el primer arranque desde un
clon limpio funciona sin pasos previos), espera la salud de cada fase, reinicia lo que se
caiga y con Ctrl+C (o el `SIGTERM` de systemd) para la pila entera. Los logs salen por
consola con prefijo por servicio y quedan también en `storage/logs/`.

Para abrirlo a tu red local, define en el `.env` `HYDRA_HOST=0.0.0.0` y un
`HYDRA_AUTH_TOKEN` (ver [Seguridad](#seguridad)); la propia salida de `pnpm serve` te
dirá las URLs. Sin token, la API se queda en loopback.

Para que arranque solo al encender la máquina hay una unidad de systemd lista en
[`deploy/hydraops.service`](deploy/hydraops.service), con las instrucciones de
instalación dentro; los logs de todos los servicios acaban en el journal
(`journalctl -u hydraops -f`).

#### Modo escritorio

La ventana de Electron, con splash y supervisor integrados:

```bash
pnpm desktop        # compila paquetes + interfaz y abre la aplicación
pnpm desktop:quick  # sin recompilar (relanzado más rápido)
```

#### Modo desarrollo

Con recarga en caliente:

```bash
pnpm dev                    # los servicios en modo watch
pnpm --filter ui start      # la interfaz, aparte, en el 4200
```

### Empaquetar el instalador

```bash
pnpm build           # los paquetes primero: el resto consume su dist/, no el fuente
pnpm desktop:dist    # interfaz + backend autocontenido + instalador NSIS
```

El resultado queda en `apps/desktop/release/`. Cierra la aplicación antes: el instalador
no puede sobrescribir archivos en uso.

### Publicar una versión

Empujar un tag `v*` dispara [`.github/workflows/release.yml`](.github/workflows/release.yml):
un runner de Windows compila el instalador y lo sube —con el `latest.yml` del que depende
la autoactualización— a una Release de GitHub. Para sacar una:

```bash
# sube la versión en apps/desktop/package.json (p. ej. 0.1.1), y luego:
git commit -am "Versión 0.1.1"
git tag v0.1.1
git push origin main --tags
```

El tag debe coincidir con la versión de `apps/desktop/package.json`. Las apps de escritorio
instaladas consultan esa Release al arrancar, descargan la versión nueva en segundo plano y
ofrecen reiniciar. El instalador aún no está firmado, así que la **primera** instalación
muestra el aviso de SmartScreen (la autoactualización se verifica por hash, no por firma).
El modo servidor (headless) no usa esto — se actualiza con `git pull` (ver
[Modo servidor](#modo-servidor-headless)).

## Configuración

Las claves de API se ponen **desde la vista Configuración de la aplicación**, no en
archivos. El `.env` solo guarda infraestructura y el modelo local; mira `.env.example`,
que explica cada variable.

Los tres ajustes del modelo local (`LOCAL_LLM_URL`, `LOCAL_LLM_KEY`, `LOCAL_LLM_MODEL`)
viven únicamente en el `.env` a propósito, y los workers lo releen en cada tarea: puedes
cambiar de servidor local sin reiniciar nada.

Por agente, desde la vista Agentes: el modelo, el tipo de worker, los pasos que puede dar
una tarea, cuánta conversación anterior lleva. La zona horaria del calendario está en
Configuración; las integraciones (GitHub, Hugging Face, Civitai, X, Telegram) tienen sus
tarjetas en Herramientas.

## Seguridad

Cuatro cosas que ya están resueltas:

- **Las claves de API nunca salen del cortafuegos.** Viven fuera del proyecto y las inyecta
  el key-proxy en la frontera de red: ni los workers, ni la base de datos, ni el `.env`
  llegan a ver una clave real.
- **Todas las herramientas pasan por un guard** que bloquea rutas de credenciales y
  comandos destructivos, redacta secretos de los resultados e impide que `fetch_url`
  alcance direcciones internas.
- **La API escucha solo en `127.0.0.1`.** De fábrica no es alcanzable desde otra máquina.
- **Abrirla a la red exige un token.** Con `HYDRA_HOST=0.0.0.0` la API pide
  `HYDRA_AUTH_TOKEN`: el navegador lo pregunta una vez (pantalla de login) y sin token
  definido la API directamente se niega a abrirse. Las conexiones desde la propia máquina
  no lo necesitan.

Un límite que conviene conocer: el token viaja **en claro por HTTP**, así que sirve para tu
red local, no para exponer el puerto a internet. Si algún día quieres accederlo desde fuera
de casa, ponlo detrás de HTTPS (un proxy inverso con certificado o una VPN tipo WireGuard
o Tailscale) — y con proxy inverso delante, activa `HYDRA_AUTH_STRICT=1` para que el token
se exija también a esas conexiones.

Para reportar un fallo, mira [SECURITY_es.md](SECURITY_es.md) o escribe a
**security@hydraops.org**.

## Privacidad

HydraOps corre por completo en tu máquina y no recopila ningún dato propio — mira
la [Política de Privacidad](PRIVACY_es.md).

## Contacto

Preguntas, ideas, lo que sea: **hi@hydraops.org** — o abre un issue.

Síguenos en X: [@HydraOpsApp](https://x.com/HydraOpsApp).

HydraOps se integra con GitHub a través de su API (el add-on `github`: repositorios, issues y pull requests) y es miembro del [GitHub Developer Program](https://docs.github.com/es/get-started/exploring-integrations/github-developer-program). Soporte de la integración: **hi@hydraops.org**.

## Licencia

Apache 2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).

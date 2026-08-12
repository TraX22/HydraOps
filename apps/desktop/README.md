# @hydraops/desktop

Shell de escritorio (Electron) para HydraOps: una ventana nativa que arranca
toda la pila y muestra la interfaz, en lugar de tener que lanzar los scripts de
PowerShell y abrir el navegador.

## Arrancar

```bash
pnpm desktop          # compila la UI y abre la app
pnpm desktop:quick    # abre la app reutilizando el build existente de la UI
```

Para desarrollar la interfaz con recarga en caliente, apunta la ventana al
servidor de Angular en lugar del build:

```bash
pnpm --dir ui start                                   # ng serve en :4200
HYDRA_DEV_UI_URL=http://localhost:4200 pnpm desktop:quick
```

## Qué hace al arrancar

1. Muestra un splash con el progreso.
2. Toma una foto de los procesos ya en ejecución. **Lo que ya esté levantado se
   adopta**: si tenías la pila corriendo con `start-infra.ps1`, la app no la
   duplica ni la mata al cerrarse.
3. Lanza lo que falte en tres fases, esperando a que cada una responda:
   - Fase 0: NATS (4222) y key-proxy (9099)
   - Fase 1: API (3000)
   - Fase 2: orchestrator, outbox-worker y los 4 workers
4. Sirve la UI compilada por HTTP en un puerto efímero de loopback y abre la
   ventana.

Al cerrar, mata el árbol de procesos de todo lo que lanzó (con `taskkill /T`,
porque `tsx` deja un proceso hijo que de otro modo quedaría huérfano).

Si un servicio se cae, se reintenta hasta 5 veces con 3 s de espera.

## Detalles de diseño

**Los hijos usan el Node que trae Electron**, no el del sistema: se lanzan con
`process.execPath` y `ELECTRON_RUN_AS_NODE=1`, así el usuario final no necesita
tener Node instalado.

Esto exige que los módulos nativos sean **N-API**, que es independiente del ABI.
`better-sqlite3` se actualizó de la 11.x (que compilaba contra el ABI concreto)
a la 13.x, cuyos binarios precompilados cargan igual en Node del sistema
(ABI 137) que en Electron (ABI 143). Verificado en los dos runtimes. Si algún
día se añade otro módulo nativo, tiene que cumplir lo mismo — si no, habría que
recompilarlo con `@electron/rebuild` y mantener dos binarios.

**La detección de servicios vivos mira los procesos del sistema**, no los
heartbeats de la BD: un heartbeat sobrevive varios minutos a la muerte del
proceso, así que un worker recién cerrado parecería vivo y nunca se relanzaría.

**Los logs** de cada servicio van a
`%APPDATA%\@hydraops\desktop\logs\<servicio>.log` (menú → *Abrir carpeta de
logs*) y además se guardan las últimas 400 líneas en memoria, accesibles desde
el renderer por IPC.

## API expuesta al renderer

`preload.js` publica `window.hydraDesktop` con aislamiento de contexto (sin
`require` ni Node en el renderer):

```js
window.hydraDesktop.isDesktop            // true → la UI corre dentro de la app
await window.hydraDesktop.info()         // versiones, rutas
await window.hydraDesktop.services.list()
await window.hydraDesktop.services.logs("worker-coder")
await window.hydraDesktop.services.restart("api")
window.hydraDesktop.services.onStatus(cb) // devuelve función para desuscribirse
```

Todavía **no** lo consume nadie: la vista Sistema sigue preguntando a la API.
Engancharla a este puente daría estado y reinicio de servicios sin depender de
que la API esté viva.

## Dónde viven los datos

Todo lo escribible se resuelve por `@hydraops/config` (`packages/config/src/paths.ts`),
que separa dos raíces:

- **`appRoot`** — código y recursos que viajan con la aplicación y que nadie
  modifica: migraciones de drizzle, `img/`. Se fuerza con `HYDRA_APP_ROOT`.
- **`dataRoot`** — lo del usuario: `db.sqlite3`, `agents/`, `users/`,
  `storage/`, `my_addons/`, `.env` y el almacén de JetStream. Se fuerza con
  `HYDRA_DATA_DIR`.

En desarrollo las dos apuntan a la raíz del repositorio, así que nada se mueve.
Instalado, el reparto es:

```
%APPDATA%\HydraOps\
  keys.json    ← almacén del key-proxy; NO tocar (ojo: %APPDATA%\hydraops
                 y %APPDATA%\HydraOps son la misma carpeta en Windows)
  shell\       ← estado de Electron + logs del supervisor
  data\        ← dataRoot (incluye node_modules\ para los add-ons)
```

`data-dir.js` prepara `data\` en cada arranque: copia los agentes y add-ons de
ejemplo si faltan (nunca pisa lo editado), crea un perfil vacío y un `.env` con
las claves a `proxy`, y corre las migraciones y el alta de agentes. Los dos
pasos son idempotentes.

También siembra un `data\node_modules\` con lo que los add-ons necesitan
importar. Hace falta porque un add-on no se compila con nadie: es un archivo
suelto que el cargador importa en caliente desde `data\my_addons\<x>\index.ts`,
así que sus `import` se resuelven subiendo desde ahí. En desarrollo cuela
—`my_addons` está dentro del repositorio— pero instalado la carpeta está sola y
hasta el add-on de ejemplo (que usa `zod`) falla con `ERR_MODULE_NOT_FOUND`.
La lista está en `ADDON_RUNTIME`, en `data-dir.js` y en `tools/build-backend.mjs`:
para añadir un paquete hay que tocar los dos. El usuario puede meter los suyos
en esa carpeta a mano.

## Empaquetado

```bash
pnpm desktop:pack    # carpeta suelta en apps/desktop/release/win-unpacked
pnpm desktop:dist    # instalador NSIS
```

Los dos compilan primero la UI y el backend autocontenido (`pnpm build:backend`
→ `build/backend/`), donde cada servicio queda en un único `.js` con sus
dependencias dentro; solo `better-sqlite3` y `sharp` viajan como módulos
aparte, porque cargan binarios de disco.

Detalles que costaron y conviene no volver a tropezar:

- `pnpm deploy` **no sirve** en Windows con pnpm 9: deja el proyecto y el store
  en carpetas distintas.
- En tsup, **`noExternal` gana a `external`**: un `noExternal: [/.*/]` se traga
  también los nativos, hay que excluirlos en el propio patrón.
- La salida es ESM pero arrastra dependencias CommonJS, así que el bundle lleva
  un banner que fabrica `require`, `__filename` y `__dirname`.
- Las entradas de tsup son globs: en Windows hay que pasarlas **relativas y con
  barras normales**, o la barra invertida escapa.
- `electron-builder` **descarta `node_modules`** dentro de un `extraResources`.

Para probar el camino de instalación sin llegar a empaquetar:

```bash
HYDRA_BACKEND_ROOT=D:/HydraOps/build/backend HYDRA_DATA_DIR=D:/tmp/prueba pnpm desktop:quick
```

Si el ejecutable empaquetado se cierra sin decir nada, el rastro está en
`%APPDATA%\HydraOps\shell\logs\shell.log` y en `hydraops-crash.log`.

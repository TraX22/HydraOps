# Instalación

## Opción A — instalador de Windows

1. Descarga el `HydraOps-x.y.z-setup.exe` de la página de *Releases* del repositorio.
2. Ejecútalo y elige la carpeta de instalación. No necesita Node, ni pnpm, ni nada más: todo va dentro.
3. Abre HydraOps desde el menú de inicio. La primera vez siembra un agente de ejemplo y los add-ons de muestra.

Tus datos van a `%APPDATA%\HydraOps` y tus claves de API a `%APPDATA%\hydraops\keys.json`, fuera de la carpeta de instalación: actualizar la aplicación no borra nada tuyo.

Para actualizar, instala la versión nueva encima. Cierra antes la aplicación: el instalador no puede sobrescribir archivos en uso.

### La bandeja del sistema y el arranque con Windows

Cerrar la ventana con la **X no apaga HydraOps**: la ventana se oculta y queda un icono en la bandeja del sistema, junto al reloj, mientras los agentes, las tareas programadas y el bot de Telegram siguen trabajando. Un clic en el icono vuelve a abrir la ventana; **Salir**, en su menú, apaga todo de verdad.

En **Config → Escritorio** podés cambiar ese comportamiento y activar **Iniciar con Windows** (y, si querés, **Empezar en la bandeja**, sin abrir la ventana): así el PC arranca y HydraOps ya está en marcha. Es lo que conviene en una máquina dedicada 24/7. Windows lo lista en Configuración → Aplicaciones → Inicio, donde también se puede apagar.

Cada cierre queda anotado con su motivo en `%APPDATA%\HydraOps\shell\logs\shell.log` (la X, Salir, cierre de sesión…), por si algún día parece que "desapareció".

## Opción B — desde el código (Windows, Linux, macOS)

Requisitos:

- **Node 20 o superior**
- **pnpm 9** (`corepack enable` lo activa si tienes Node)
- El binario de **nats-server** — **imprescindible**: es el bus de mensajes que conecta la API con los agentes; sin él los *workers* no arrancan y las tareas se quedan sin responder. Instálalo según tu sistema (elige la última versión en las [releases de nats-server](https://github.com/nats-io/nats-server/releases)):
  - **Debian / Ubuntu (y derivados):** descarga el paquete **`.deb`** de tu arquitectura — `nats-server-vX.Y.Z-amd64.deb` para un PC de 64 bits, `-arm64.deb` para ARM (Raspberry Pi, etc.). Instálalo con **doble clic** (se abre el gestor de software del sistema) o desde la terminal:

    ```bash
    sudo dpkg -i nats-server-*-amd64.deb
    # o, si prefieres apt (resuelve dependencias) — ojo al ./ :
    sudo apt install ./nats-server-*-amd64.deb
    ```

    (`apt install nats` a secas NO funciona: `nats-server` no está en los repos de apt.)

  - **Fedora / RHEL / openSUSE:** descarga el **`.rpm`** equivalente (`nats-server-vX.Y.Z-amd64.rpm`) y haz **doble clic**, o `sudo rpm -i nats-server-*-amd64.rpm`.
  - **macOS:** `brew install nats-server`.
  - **Windows:** `choco install nats-server` (o usa directamente el instalador `.exe` de la Opción A, que ya lo trae dentro).
  - **Alternativa universal (cualquier sistema):** descarga el binario comprimido (`.tar.gz` / `.zip`), y déjalo en el `PATH`, en una carpeta `nats/` dentro del repositorio, o apúntalo con `NATS_SERVER_BIN` en el `.env`.

  Para comprobar que quedó bien instalado: `nats-server --version`.

```bash
git clone https://github.com/TraX22/HydraOps.git
cd HydraOps
pnpm install
cp .env.example .env
```

Y para arrancar (compila paquetes + interfaz por ti, así que tras un `git pull` no hay que recordar ningún build aparte):

```bash
pnpm serve
```

Eso levanta la pila entera y deja la aplicación en `http://127.0.0.1:3000`. La salida del comando te dirá las URLs exactas. Para dejarla corriendo 24/7 o abrirla a tu red local, sigue en [Modo servidor](./12-server-mode.md).

En Windows también puedes usar la ventana de escritorio desde el código con `pnpm desktop`.

### Actualizar (Linux, macOS y Windows desde el código)

Hay dos formas; las dos conservan tus datos (agentes, base de datos, adjuntos y claves viven fuera del código).

**Desde la aplicación.** Cuando hay una versión nueva, la vista **Sistema** muestra un aviso con el botón **Actualizar**. Al pulsarlo, HydraOps hace `git pull` de la última release, recompila y reinicia sus servicios solo; la interfaz se recarga al terminar. Solo funciona si la instalación es un clon de git sin cambios locales sin guardar (si los hay, te lo dice).

**A mano**, desde la carpeta del repositorio:

```bash
git pull
pnpm install      # solo hace falta si cambiaron las dependencias; no cuesta nada ejecutarlo siempre
pnpm serve        # compila paquetes e interfaz y arranca; aplica las migraciones de la base de datos antes de levantar nada
```

Si la pila estaba corriendo, párala antes (Ctrl+C, o `systemctl stop hydraops` si la dejaste como servicio; ver [Modo servidor](./12-server-mode.md)). Para saber qué versión tienes: aparece abajo del menú lateral, y `git describe --tags` en la terminal.

## Después de instalar

Sigue con [Primeros pasos](./03-first-steps.md): configurar una clave de API (o un modelo local) y crear tu primer agente.

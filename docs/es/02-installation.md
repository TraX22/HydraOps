# Instalación

## Opción A — instalador de Windows

1. Descarga el `HydraOps-x.y.z-setup.exe` de la página de *Releases* del repositorio.
2. Ejecútalo y elige la carpeta de instalación. No necesita Node, ni pnpm, ni nada más: todo va dentro.
3. Abre HydraOps desde el menú de inicio. La primera vez siembra un agente de ejemplo y los add-ons de muestra.

Tus datos van a `%APPDATA%\HydraOps` y tus claves de API a `%APPDATA%\hydraops\keys.json`, fuera de la carpeta de instalación: actualizar la aplicación no borra nada tuyo.

Para actualizar, instala la versión nueva encima. Cierra antes la aplicación: el instalador no puede sobrescribir archivos en uso.

## Opción B — desde el código (Windows, Linux, macOS)

Requisitos:

- **Node 20 o superior**
- **pnpm 9** (`corepack enable` lo activa si tienes Node)
- El binario de **nats-server**: instálalo con tu gestor de paquetes (`apt`, `brew`, `choco`…) o descárgalo de sus [releases](https://github.com/nats-io/nats-server/releases). Vale con que esté en el `PATH`; también puedes dejarlo en una carpeta `nats/` del repositorio o apuntarlo con `NATS_SERVER_BIN` en el `.env`.

```bash
git clone https://github.com/TraX22/HydraOps.git
cd HydraOps
pnpm install
cp .env.example .env
pnpm build                  # los paquetes del monorepo
pnpm --filter ui build      # la interfaz
```

Y para arrancar:

```bash
pnpm serve
```

Eso levanta la pila entera y deja la aplicación en `http://127.0.0.1:3000`. La salida del comando te dirá las URLs exactas. Para dejarla corriendo 24/7 o abrirla a tu red local, sigue en [Modo servidor](./10-server-mode.md).

En Windows también puedes usar la ventana de escritorio desde el código con `pnpm desktop`.

## Después de instalar

Sigue con [Primeros pasos](./03-first-steps.md): configurar una clave de API (o un modelo local) y crear tu primer agente.

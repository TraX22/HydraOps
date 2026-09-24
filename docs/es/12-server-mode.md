# Modo servidor

El modo servidor es tener HydraOps encendido 24/7 en una máquina sin pantalla —un mini PC en casa, un viejo portátil— y usarlo desde el navegador de cualquier equipo de tu red. También es lo que hace que las [tareas programadas](./10-scheduled-tasks.md) corran siempre.

## Arrancar la pila

Con el proyecto [instalado desde el código](./02-installation.md):

```bash
pnpm serve
```

Un solo comando levanta NATS y los ocho servicios, sin ventana. Aplica las migraciones y siembra la base de datos él solo, espera la salud de cada fase, reinicia lo que se caiga, y con Ctrl+C para la pila entera. Los logs salen por consola con prefijo por servicio.

Con eso ya tienes la aplicación en `http://127.0.0.1:3000` — pero solo desde esa máquina.

## Abrirlo a tu red local

Una línea en el `.env`:

```bash
HYDRA_HOST=0.0.0.0
```

Reinicia `pnpm serve`. La primera vez, HydraOps ve que no hay token, **genera un `HYDRA_AUTH_TOKEN` largo y aleatorio, lo guarda en el `.env`** y lo imprime una vez en la salida, junto a las URLs de red (`http://192.168.x.x:3000`). También aparece en **Config → Acceso por red** en el propio servidor (nunca a otro equipo), con botones para mostrarlo y copiarlo. Si prefieres tu propio token, pon `HYDRA_AUTH_TOKEN=...` en el `.env` antes de reiniciar y se usa tal cual.

Desde otro equipo, el navegador te pedirá el token una vez (pantalla de login) y quedará una sesión de 30 días; "Cerrar sesión" está en la vista Perfil.

![La pantalla de login que ve otro equipo de la red](../img/es/login.png)

Las conexiones desde la propia máquina del servidor nunca necesitan token. Si el token no se puede guardar (el `.env` es de solo lectura), la API se niega a abrirse a la red y se queda en `127.0.0.1`.

### `0.0.0.0` o una dirección concreta

`0.0.0.0` significa "escuchar en todas las interfaces de red": el cable y el Wi-Fi, o sea cualquier dispositivo que pueda llegar a la máquina. Detrás del router de casa eso es tu red local, y está bien. Dos cosas a tener en cuenta:

- El token viaja en claro por HTTP: vale para la red de tu casa, **no** para abrir el puerto a internet ni para un Wi-Fi compartido.
- Para entrar desde fuera de casa, no abras el puerto en el router. La forma segura más simple es **Tailscale** (una red privada gratuita entre tus dispositivos): instálalo en el servidor y en el celular, y pon en `HYDRA_HOST` la dirección de Tailscale del servidor (`100.x.y.z`, la muestra `tailscale ip -4`) en lugar de `0.0.0.0`. Así HydraOps escucha solo en esa red privada cifrada —invisible para tu LAN y para internet— y entras desde cualquier lado con `http://100.x.y.z:3000`. La alternativa es HTTPS con un proxy inverso y certificado; con proxy delante, añade `HYDRA_AUTH_STRICT=1` al `.env`.

## Arrancar solo al encender (Linux, systemd)

En el repositorio hay una unidad lista: [`deploy/hydraops.service`](../../deploy/hydraops.service), con las instrucciones de instalación en sus comentarios. En resumen:

```bash
sudo cp deploy/hydraops.service /etc/systemd/system/
# edita User=, WorkingDirectory=, ExecStart= y ReadWritePaths= a tu usuario y tu ruta
sudo systemctl daemon-reload
sudo systemctl enable --now hydraops
```

Los logs de todos los servicios acaban en el journal: `journalctl -u hydraops -f`. Parar con `systemctl stop hydraops` hace un apagado limpio de la pila entera.

## Actualizar un servidor

El botón **Actualizar** de la vista Sistema también funciona en modo servidor (hace `git pull`, recompila y reinicia los servicios en sitio). A mano:

```bash
sudo systemctl stop hydraops      # o Ctrl+C si lo arrancaste con pnpm serve
git pull
pnpm install
pnpm build && pnpm --filter ui build
sudo systemctl start hydraops     # o pnpm serve de nuevo
```

Más detalle en [Instalación → Actualizar](./02-installation.md).

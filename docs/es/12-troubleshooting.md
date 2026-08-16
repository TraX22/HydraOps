# Problemas frecuentes

## Envío mensajes y nadie contesta

- **¿Hay agentes?** Sin agentes, las tareas se quedan sin asignar en silencio. Crea uno en la vista Agentes.
- **¿El agente tiene modelo utilizable?** Si su modelo es de un proveedor sin clave, la tarea falla. Mira su ficha y la vista Configuración.
- **¿Están vivos los workers?** Vista Sistema: si el worker del tipo del agente está caído, sus logs dicen por qué.
- **¿Está `nats-server` instalado?** Es el bus que conecta la API con los agentes; sin él los workers no arrancan y las tareas se quedan sin respuesta. Instálalo (`.deb`/`.rpm` de doble clic en Linux) siguiendo [Instalación](./02-installation.md) y comprueba con `nats-server --version`.

## "No hay servidor local configurado" / errores de conexión con el modelo local

Los tres `LOCAL_LLM_*` viven en el `.env` — ver [Claves de API y modelos](./04-api-keys.md). Comprueba que `LOCAL_LLM_URL` apunta a tu servidor real (con `/v1` si toca) y que el servidor está arrancado. No hace falta reiniciar HydraOps: se relee en cada tarea.

## El agente no "ve" las imágenes que adjunto

El modelo del agente tiene que tener visión. Con modelo local, además, el servidor debe llevar el proyector multimodal cargado (en llama.cpp, el archivo `mmproj`); si el modelo es solo-texto, el agente inventará una descripción en vez de ver la imagen.

## No arranca: NATS no se encuentra

El binario `nats-server` tiene que estar en el `PATH`, en una carpeta `nats/` del repositorio, o apuntado con `NATS_SERVER_BIN` en el `.env` — ver [Instalación](./02-installation.md). El instalador de Windows lo trae dentro; esto solo aplica al modo desde el código.

## No arranca: el puerto 3000 está ocupado

Otra cosa escucha en el 3000 (¿otra instancia de HydraOps?). Cierra la otra aplicación o cambia `PORT` en el `.env`.

## Desde otro equipo no llego a la aplicación

- ¿`HYDRA_HOST=0.0.0.0` **y** `HYDRA_AUTH_TOKEN` en el `.env`? Sin token, la API se queda en `127.0.0.1` a propósito.
- ¿El cortafuegos de la máquina permite el puerto 3000?
- Tras demasiados intentos fallidos de login hay un bloqueo temporal por IP: espera unos minutos.

## He perdido el token

Está en claro en el `.env` del servidor (`HYDRA_AUTH_TOKEN`). Cámbialo cuando quieras y reinicia la pila; las sesiones abiertas siguen valiendo hasta que caduquen o cierren sesión.

## El instalador de Windows falla al actualizar

Cierra HydraOps antes de instalar: el instalador no puede sobrescribir archivos en uso.

## ¿Reinstalar borra mis datos?

No. Datos y claves viven fuera de la instalación (`%APPDATA%\HydraOps` y `%APPDATA%\hydraops\keys.json`). Desinstalar y reinstalar te devuelve tus agentes, tu historial y tus claves. Eso también significa que **borrar la aplicación no borra tus claves**: para eso, borra esas dos carpetas.

## Dónde mirar cuando nada de esto encaja

Los logs: vista Sistema, o los archivos de `storage/logs/` en la carpeta de datos (en el modo systemd, `journalctl -u hydraops -f`). Con el fragmento del error, abre un issue en el repositorio o escribe a **hi@hydraops.org**. También puedes seguir el proyecto y escribirnos en X: [@HydraOpsApp](https://x.com/HydraOpsApp).

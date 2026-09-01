# Complementos y One Shot

**Complementos** es un cajón de mini-aplicaciones dentro de HydraOps. Se abre desde **Complementos** en la barra lateral (encima de *Tareas*) y aparece como una ventana, sin salir de donde estabas. Hoy trae una sola mini-app: **One Shot** (en beta).

## Qué es One Shot

Dar un buen prompt es difícil: uno se enreda, se olvida piezas, no sabe por dónde empezar. One Shot le da la vuelta: **dibujas la tarea como un diagrama de flujo** —cajas con texto, unidas por flechas— y HydraOps, con el modelo que ya tienes configurado, lo **compila en un único prompt "one-shot"** limpio y autocontenido, listo para enviar.

El diagrama representa la **lógica** de lo que quieres (de dónde sale la información → pasos → decisiones → qué debe entregar), no sus "secciones". No hace falta redactar: basta con pensarlo en cajas.

## Dibujar el diagrama

- **Añadir nodo** crea una caja con un **título** y un **cuerpo** de texto, los dos editables. Escribe en cada una la pieza que representa.
- **Conectar** dos nodos: arrastra desde el borde de uno hasta el otro. Cada nodo tiene un punto de conexión por lado y la flecha elige sola por dónde salir.
- **Re-rutear** una flecha: arrastra uno de sus extremos hasta otro nodo.
- **Borrar** una flecha: haz clic sobre ella para seleccionarla y pulsa **Supr** (o el botón de borrar que aparece).
- Arrastra los nodos para acomodarlos; abajo tienes los controles de **zoom** y **encajar a pantalla**, y un minimapa.

## Compilar y usar el prompt

1. Elige el **agente** (define qué modelo compila el diagrama).
2. Pulsa **Compilar**. El diagrama viaja al modelo —la clave la inyecta el key-proxy, igual que en cualquier tarea— y vuelve el prompt ya redactado.
3. Con el resultado, **Copiar** al portapapeles o **Enviar al chat**: esto abre el canal del agente con el prompt ya puesto, como una tarea más. Ver [El chat](./06-chat.md).

## Historial de diagramas

Cada diagrama se **guarda solo** mientras trabajas, con un nombre que puedes editar. El panel de la derecha lista tus diagramas, el más reciente arriba; desde ahí creas uno nuevo, abres otro o lo borras (con confirmación, para no perder trabajo de un clic). Todo se guarda en tu navegador, en este equipo.

> One Shot está en **beta**: los nodos son de texto genérico por ahora. Nodos con tipo o imagen, plantillas de diagrama y más mini-aplicaciones llegarán después.

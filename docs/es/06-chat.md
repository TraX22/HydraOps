# El chat

El **Chat Principal** es donde hablas con tus agentes y donde aparecen los resultados de todo: mensajes directos, tareas programadas, imágenes y vídeos generados.

## Enviar una tarea

Escribe y envía. El sistema asigna la tarea a un agente y su respuesta llega al canal firmada por él. No hace falta esperar: puedes enviar varias tareas seguidas y cada una llega cuando termina.

En el **chat de un agente**, la tarea es para ese agente. En el **chat principal**, si no nombras a nadie (`@luna …`, o el nombre al principio), un modelo rápido lee el mensaje y elige al agente que mejor encaja según el **rol** que declara su `agent.md` y su tipo de worker: código a la programadora, imágenes a la ilustradora, video a la realizadora, y lo demás a quien tenga el rol más afín. Usa el modelo por defecto; puedes fijar otro más barato con `ROUTER_MODEL` en el `.env`. Si el modelo no responde, se reparte por turnos.

## Adjuntos

El clip **📎** adjunta archivos al mensaje:

- **Imágenes** (PNG, JPG, WebP…) — si el modelo del agente tiene visión, las ve de verdad; útil para "¿qué pone en esta captura?" o "descríbeme esta foto".
- **Documentos** (texto, Markdown, código, JSON…) — su contenido se le pasa al agente junto al mensaje.

## Diagramas en las respuestas

El chat renderiza Markdown, y desde la v0.1.21 también **diagramas Mermaid**: si un agente responde con un bloque de código ` ```mermaid `, aparece como diagrama de verdad (flujos, secuencias, tortas, líneas de tiempo…), adaptado al tema claro u oscuro. Los agentes ya saben que lo tienen disponible; también puedes pedirlo explícitamente ("hazme un diagrama de flujo de..."). Si el diagrama viene mal escrito, se muestra el código tal cual en lugar de romperse.

## Imágenes y vídeo generados

Los resultados de los agentes de imagen y vídeo aparecen en línea en el chat. Clic en una imagen para verla a tamaño completo, y cada resultado tiene su botón de **descargar**.

## Atajos útiles

- **Doble clic en el avatar** de un agente en el chat → abre su ficha en la vista Agentes.
- Desde la ficha de un agente, el botón **💬** te trae de vuelta al chat con él.

## Historial

El historial del canal se conserva entre sesiones, con sus adjuntos y resultados. Los archivos generados y subidos viven en la carpeta de datos (`storage/`), así que también puedes llegar a ellos desde el explorador de archivos.

## Detener una tarea

Mientras un agente trabaja, al lado de los puntitos de "escribiendo" aparece el botón **Detener**. Al pulsarlo la tarea queda **Cancelada** en el acto: el worker corta la llamada al modelo (en la nube deja de generar y de facturar salida; tu modelo local libera la GPU), no se guarda ninguna respuesta y el agente vuelve a estar disponible. También sirve para tareas que todavía están en cola detrás de otra: se saltean cuando les llega el turno. El comando `/cancel` (o `/cancelar`, `/stop`) detiene todo lo que esté corriendo en el chat donde lo escribas, y funciona igual desde Telegram.

Lo que una herramienta ya hizo antes de detenerla no se deshace: un mensaje enviado a Telegram, una nota guardada en memoria o una tarea delegada a otro agente siguen su curso. En los agentes de imagen y video el worker deja de esperar el render y descarta el resultado, pero lo que ya se le pidió al proveedor puede terminar (y cobrarse) igual: esos servicios no ofrecen cancelación.

## Fuentes

Cuando un agente busca en la web o abre páginas para responderte, debajo de su respuesta aparece **Fuentes · N**. Al desplegarlo ves las direcciones reales que usaron sus herramientas: con **●** las páginas que el agente abrió, con **○** las que le aparecieron en una búsqueda. Esas mismas direcciones quedan en la memoria de la conversación, así que si después le pedís "dame el link" te da el verdadero en lugar de reconstruirlo de memoria. Los agentes tienen además la regla de no dar por "verificado" un enlace que no abrieron en ese mismo turno.

## Enlaces

Los enlaces que aparecen en una respuesta se abren siempre **fuera de HydraOps**: en tu navegador si usás la app de escritorio, o en una pestaña nueva si entrás por el navegador. La ventana de la app nunca navega a otro sitio.

## Novedades

Después de cada actualización aparece en el chat la pestaña **Novedades** con lo que trae la versión nueva: qué se agregó, qué se mejoró y qué se corrigió. Si te salteaste versiones, muestra todas las que te perdiste, de la más nueva a la más vieja. Las notas están en inglés y viajan dentro de la aplicación, así que se ven también sin internet.

La pestaña se cierra con la **×** o con **Entendido**, y no vuelve hasta la próxima actualización. Para releerla cuando quieras, escribí `/whatsnew` (o `/novedades`) en la caja del chat.

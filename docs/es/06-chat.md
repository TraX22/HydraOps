# El chat

El **Chat Principal** es donde hablas con tus agentes y donde aparecen los resultados de todo: mensajes directos, tareas programadas, imágenes y vídeos generados.

## Enviar una tarea

Escribe y envía. El sistema asigna la tarea a un agente y su respuesta llega al canal firmada por él. No hace falta esperar: puedes enviar varias tareas seguidas y cada una llega cuando termina.

En el **chat de un agente**, la tarea es para ese agente. En el **chat principal**, si no nombras a nadie (`@luna …`, o el nombre al principio), un modelo rápido lee el mensaje y elige al agente que mejor encaja según el **rol** que declara su `agent.md` y su tipo de worker: código a la programadora, imágenes a la ilustradora, video a la realizadora, y lo demás a quien tenga el rol más afín. Usa el modelo predeterminado salvo que elijas otro en **Config → Modelo de enrutado del Chat Principal** (conviene uno rápido: solo reparte el mensaje; con un modelo de API, ese mensaje sale a ese proveedor). Si el modelo no responde, se reparte por turnos.

## Adjuntos

El clip **📎** adjunta archivos al mensaje. También puedes **arrastrar archivos al chat** (un marco muestra dónde soltarlos) o **pegar una imagen copiada** con Ctrl+V en el cuadro del mensaje, por ejemplo una captura de pantalla. Cada archivo puede pesar hasta 20 MB:

- **Imágenes** (PNG, JPG, WebP…) — si el modelo del agente tiene visión, las ve de verdad; útil para "¿qué pone en esta captura?" o "descríbeme esta foto".
- **Documentos** (texto, Markdown, código, JSON…) — su contenido se le pasa al agente junto al mensaje.

## Texto para copiar

Cuando un agente escribe algo para que lo pegues en otro lado — un prompt, un comando, un mensaje para enviar — lo pone en un bloque con marco y un botón de **copiar** arriba a la derecha, separado de sus propios comentarios. El botón copia exactamente lo que hay en el marco. Si una respuesta llegó sin el marco, pídelo ("dámelo en un bloque de código"); el icono de copiar debajo de cada respuesta copia la respuesta entera.

## Diagramas en las respuestas

El chat renderiza Markdown, y desde la v0.1.21 también **diagramas Mermaid**: si un agente responde con un bloque de código ` ```mermaid `, aparece como diagrama de verdad (flujos, secuencias, tortas, líneas de tiempo…), con los colores de HydraOps en el tema claro y en el oscuro. Un clic sobre el diagrama lo abre a pantalla completa (otro clic o Esc lo cierra). Los agentes ya saben que lo tienen disponible; también puedes pedirlo explícitamente ("hazme un diagrama de flujo de..."). Si el diagrama viene mal escrito, se muestra el código tal cual en lugar de romperse.

## Imágenes y vídeo generados

Los resultados de los agentes de imagen y vídeo aparecen en línea en el chat. Clic en una imagen para verla a tamaño completo, y cada resultado tiene su botón de **descargar**.

## Modelos 3D

Cuando una tarea entrega un modelo 3D (un archivo GLB, por ejemplo uno generado con [ComfyUI](./09-tools.md)), debajo de la respuesta aparece una tarjeta con su nombre, tamaño y cantidad de triángulos. No se descarga nada hasta que lo pidas:

- **Ver en 3D** carga el modelo y abre el visor dentro del mensaje. Arrastra para girar, usa la rueda para acercar y el clic derecho para mover.
- Los botones del visor vuelven a la **vista inicial**, dibujan la **malla** sobre el modelo y lo **agrandan** sobre la ventana (Esc lo achica). Agrandado, un cuadro muestra los triángulos, vértices, texturas y tamaño del modelo.
- **Descargar** guarda el archivo; funciona sin abrir el visor.

El modelo se dibuja en un marco aislado y con una librería 3D que viene con la app: funciona sin internet y un archivo no puede alcanzar nada más de la app. Los modelos muy grandes (más de 400 MB) solo se ofrecen para descargar.

## Atajos útiles

- **Doble clic en el avatar** de un agente en el chat → abre su ficha en la vista Agentes.
- Desde la ficha de un agente, el botón **💬** te trae de vuelta al chat con él.

## Historial

El historial del canal se conserva entre sesiones, con sus adjuntos y resultados. Los archivos generados y subidos viven en la carpeta de datos (`storage/`), así que también puedes llegar a ellos desde el explorador de archivos.

El chat muestra los **últimos 30 días** de cada canal, y el agente recibe como contexto los **últimos 20 intercambios** de esos días: puedes volver el lunes sobre "las webs que me propusiste el viernes". Los mensajes de más de un día le llegan con su fecha, para que los tome como una conversación anterior. Con un modelo local la conversación pasada que recibe es más corta (un límite de tamaño, no de cantidad de mensajes), para que su contexto no se llene de respuestas viejas. Lo que deba conservar para siempre, pídele que lo recuerde (ver [agentes](./05-agents.md)).

## Qué está haciendo el agente

Mientras un agente trabaja, debajo de los puntitos se ve **lo que está haciendo** y cuánto tiempo lleva: "Buscando «…»", "Leyendo cppreference.com/…", "Abriendo la skill deep-research", "Esperando tu aprobación"… Entre herramienta y herramienta dice "Pensando…". **ver pasos** despliega todo lo que hizo en esa tarea hasta ahora, útil en investigaciones largas para saber qué buscó y qué leyó. El texto de la respuesta aparece recién cuando termina.

## El baúl de la tarea

Una página web entera, una transcripción de una hora o una lista larga de issues no entran en la memoria de trabajo de un modelo; hasta ahora cada herramienta recortaba su resultado (una página a 4 000 caracteres) y lo que sobraba se perdía: una investigación larga terminaba "recordando" la primera pantalla de cada cosa que leyó. Ahora **cada resultado largo se guarda entero** en el baúl de la tarea y el agente recibe un resumen: el comienzo del texto, el índice de secciones y una marca `[baúl #3 · 42 KB]`. Con **`vault_read`** sigue leyendo (todo el documento, una sección o desde un punto) y con **`vault_find`** busca una palabra en lo que guardó. Mientras trabaja, la fila de progreso muestra **baúl: 7** (cuántos documentos lleva guardados).

Cuando la tarea es larga, lo que ya leyó no cabe entero en la memoria de trabajo del modelo. Por eso, antes de cada paso, los resultados **más viejos** que superan el presupuesto (unos 90 000 caracteres; 40 000 con un modelo local; `HYDRA_TOOL_CONTEXT_CHARS` lo cambia) se **compactan**: en la conversación queda una línea con el número de baúl y cómo volver a leerlos; nada se pierde. Para que los hallazgos sobrevivan a eso, el agente tiene **`vault_note`**: anota cifras, citas y conclusiones con su `#n`, y esas notas le vuelven en cada paso (en "ver pasos": "Anotando: …"). Si la tarea ejecuta un plan (`/plan`), arranca con los documentos que el agente ya leyó al planificar, sin volver a bajarlos.

El baúl vive en `storage/results/<tarea>/vault/` y se borra a las **24 horas**: lo justo para volver sobre una tarea al día siguiente sin que se acumule. Lo que el agente relee del baúl conserva su origen: un documento que vino de afuera (una página, una búsqueda) llega marcado como dato externo, igual que cuando lo leyó por primera vez, mientras que releer algo que no vino de afuera (el estado de tu propia aplicación, por ejemplo) no marca la tarea (ver [Seguridad](./13-security.md)). Una **skill** instalada es la excepción al resumen: el agente recibe siempre su texto completo.

## Planificar antes de hacer

Para un pedido grande, caro o difícil de deshacer, escribí **`/plan`** delante: *`/plan investigá el mercado de juegos idle en Argentina y armá un video corto para promocionar Idle Miner`*. El agente entra en **modo plan**: solo tiene las herramientas que **leen** (buscar, abrir páginas, skills, consultar GitHub); enviar, guardar en memoria, delegar, crear issues o skills y generar imágenes o video **no están disponibles** en ese momento, no es solo una instrucción. Investiga lo justo y te devuelve una **tarjeta con el plan**: el objetivo, los pasos numerados con las herramientas que va a usar en cada uno (en naranja las que actúan o cuestan, como generar un video) y a qué agente delega, y las dudas que conviene aclarar antes.

Con la tarjeta tenés cuatro caminos:

- **Aprobar y ejecutar**: se crea la tarea que hace el trabajo, con las herramientas completas. Las reglas de seguridad siguen valiendo: si en el camino lee contenido externo, las acciones sensibles quedan retenidas como siempre.
- **Editar**: el plan pasa a texto. Sacás un paso, cambiás el orden o agregás un detalle, y aprobás *esa* versión.
- **Pedir revisión**: contás qué cambiarías sin preocuparte por cómo encaja. El agente, todavía sin poder actuar, devuelve la **versión siguiente en la misma tarjeta**: pasos marcados como *nuevo*, *cambiado* o *quitado*, y una nota de **qué implica** el cambio para el resto. Los botones **v1 · v2 · v3** saltan a cada versión.
- **Descartar**: no se ejecuta nada.

Mientras el último mensaje del chat sea un plan esperando tu OK, **lo que escribas se toma como una revisión** de ese plan; el enlace *Enviar como pedido nuevo* lo manda como una tarea normal. En Telegram el plan llega con **▶ Aprobar / ✕ Descartar**; editar y revisar se hacen en la app.

## Detener una tarea

Mientras un agente trabaja, al lado de los puntitos de "escribiendo" aparece el botón **Detener**. Al pulsarlo la tarea queda **Cancelada** en el acto: el worker corta la llamada al modelo (en la nube deja de generar y de facturar salida; tu modelo local libera la GPU), no se guarda ninguna respuesta y el agente vuelve a estar disponible. También sirve para tareas que todavía están en cola detrás de otra: se saltean cuando les llega el turno. El comando `/cancel` (o `/cancelar`, `/stop`) detiene todo lo que esté corriendo en el chat donde lo escribas, y funciona igual desde Telegram.

Lo que una herramienta ya hizo antes de detenerla no se deshace: un mensaje enviado a Telegram, una nota guardada en memoria o una tarea delegada a otro agente siguen su curso. En los agentes de imagen y video el worker deja de esperar el render y descarta el resultado, pero lo que ya se le pidió al proveedor puede terminar (y cobrarse) igual: esos servicios no ofrecen cancelación.

## Fuentes

Cuando un agente busca en la web o abre páginas para responderte, debajo de su respuesta aparece **Fuentes · N**. Al desplegarlo ves las direcciones reales que usaron sus herramientas: con **●** las páginas que el agente abrió, con **○** las que le aparecieron en una búsqueda. Esas mismas direcciones quedan en la memoria de la conversación, así que si después le pedís "dame el link" te da el verdadero en lugar de reconstruirlo de memoria. Los agentes tienen además la regla de no dar por "verificado" un enlace que no abrieron en ese mismo turno.

## Enlaces

Los enlaces que aparecen en una respuesta se abren siempre **fuera de HydraOps**: en tu navegador si usás la app de escritorio, o en una pestaña nueva si entrás por el navegador. La ventana de la app nunca navega a otro sitio.

Antes de que un enlace salga de la app, un globo al lado pregunta: muestra la dirección completa, con el sitio en negrita, y **Cancelar** / **Aceptar**. Escape, un clic en otro lado o desplazar la página lo cancelan; Enter acepta. Vale para todo enlace a otro sitio (respuestas, sus fuentes, el manual), no para las páginas y archivos de la propia app.

Un enlace con subrayado punteado y un triángulo amarillo de advertencia es uno que el agente **no abrió ni vio** en esta conversación: puede existir, pero salió de la memoria del modelo. Compruébalo antes de fiarte.

## Contenido seguro

Lo que escribe un agente se muestra como Markdown, pero nunca como HTML activo: antes de pintarse, cada respuesta pasa por un filtro que elimina scripts, formularios, marcos incrustados, estilos y cualquier cosa que pueda ejecutar código o disfrazarse de parte de la app. Las imágenes solo se cargan si las sirve el propio HydraOps; una imagen de otro sitio aparece como un enlace (🖼) para que abrirla sea tu decisión y ver una respuesta nunca haga pedidos a terceros. Esto importa porque un agente que lee páginas web puede ser manipulado por el contenido de esas páginas.

## Novedades

Después de cada actualización aparece en el chat la pestaña **Novedades** con lo que trae la versión nueva: qué se agregó, qué se mejoró y qué se corrigió. Si te salteaste versiones, muestra todas las que te perdiste, de la más nueva a la más vieja. Las notas están en inglés y viajan dentro de la aplicación, así que se ven también sin internet.

La pestaña se cierra con la **×** o con **Entendido**, y no vuelve hasta la próxima actualización. Para releerla cuando quieras, escribí `/whatsnew` (o `/novedades`) en la caja del chat.

# Add-ons y MCP

Las herramientas son lo que separa a un agente que *contesta* de uno que *hace*. En HydraOps hay tres clases, y las tres se gestionan desde la vista **Add-ons**.

![La vista Add-ons: nativos, propios y servidores MCP](../img/es/addons.png)

## Add-ons nativos

Vienen con la aplicación. Hoy son:

- `web_search` — buscar en la web (DuckDuckGo, sin clave). DuckDuckGo a veces rechaza las búsquedas automáticas durante unos minutos; al agente se le dice entonces que la búsqueda fue **bloqueada**, no que no hubo resultados, para que lo avise en lugar de contestar de memoria. Si pasa seguido, dale también `brave_search`.
- `brave_search` — búsqueda con la API de Brave; la clave se pega en su tarjeta y viaja por el key-proxy.
- `perplexity_search` — pregunta a Perplexity (Sonar): busca en la web y devuelve una respuesta razonada con sus fuentes citadas; la clave se pega en su tarjeta y viaja por el key-proxy.
- `fetch_url` — descargar y leer una página.
- `browser_read` — lee la página abierta en el panel del navegador junto al chat (app de escritorio): lo que ve el usuario, sesiones incluidas. `browser_open` navega el panel a una dirección, con aprobación del usuario. Ver [Chat](./06-chat.md#el-panel-del-navegador).
- `comfy_workflows` — los flujos que guardaste en tu ComfyUI: los lista, prepara uno para correr (una copia, con los archivos que adjuntaste ya subidos, con su tamaño en píxeles anotado, y puestos en sus entradas, y dos defectos comunes de los flujos guardados ya corregidos: un número guardado como texto y un separador de línea invisible dentro de un texto, que traen algunas plantillas oficiales y la conexión de ComfyUI no puede leer; además le dice al agente qué valores vienen de otro nodo, como un ancho que sale de un selector de resolución, para que no informe como usado el número escrito en ese campo; y lista los modelos que declaran los cargadores del flujo, como los traen las plantillas oficiales con su carpeta y su enlace de descarga, diciendo cuáles no tiene tu ComfyUI) y trae lo que guardó un trabajo; su «set» escribe valores en esa copia por dirección (un prompt, una semilla, una región de recorte) conservando los valores que el set_workflow_slot de la conexión ComfyUI descartaría. Trabaja junto con la conexión de ComfyUI, que es la que corre el flujo, y llega a ComfyUI por la dirección configurada en esa conexión (ver [Herramientas](./09-tools.md)). Una generación larga no se espera: el agente te dice que está corriendo y termina su respuesta; preguntale más tarde si terminó y te trae el resultado, o te dice cuánto lleva y te ofrece cancelarla. El último trabajo que lanzó cada agente queda anotado, así que la pregunta no necesita ningún id, aunque la tarea que lo lanzó se haya cortado. Cuando el resultado es una imagen y el modelo del agente ve imágenes, el agente la mira (una copia más liviana; tu archivo es el original) y la compara con lo que pediste antes de informarte.
- `comfy_download_model` — baja un modelo que necesita un flujo a la carpeta donde tu ComfyUI lee ese tipo de modelo, que informa el propio ComfyUI: funciona con cualquier instalación (portable, de escritorio, desde git, en otro disco, con carpetas de modelos extra) sin decirle a HydraOps dónde está. Solo https y solo archivos `.safetensors` o `.gguf` (formatos que no pueden ejecutar código al cargarse), nunca sobre un archivo existente y solo para un ComfyUI en esta computadora. Cada descarga espera tu aprobación; corre en segundo plano, y `comfy_workflows` ("downloads") dice cuánto avanzó. Para un modelo que declara el flujo, el agente usa el enlace que viene en el propio flujo. Los enlaces de Hugging Face y Civitai usan el token o la clave que guardaste en [Herramientas](./09-tools.md): un modelo gated de Hugging Face (después de aceptar sus condiciones en su página) y un modelo de Civitai que pide sesión iniciada también se bajan, y la clave va solo a ese sitio, nunca al servidor del que sale el archivo. Un modelo de Civitai marcado como adulto no se baja mientras el contenido adulto esté bloqueado. Un agente que tiene esta herramienta ya no recibe `download_model` de la conexión ComfyUI, que escribe en la carpeta propia de comfy-cli y se niega cuando la conexión tiene una dirección configurada.
- `image_edit` — ediciones simples de una imagen de la tarea o de un adjunto, sin GPU: su tamaño y el recuadro del sujeto, recortar, voltear, rotar, escalar, quitar el fondo liso alrededor, o componer varias imágenes en un lienzo (una hoja de vistas a partir de imágenes sueltas, un perfil espejado junto al original, con `equal_heights` para que las figuras midan lo mismo). El resultado se guarda como PNG en la carpeta de la tarea, aparece en el chat y el agente lo ve para revisar su propio trabajo. No toca nada fuera de la tarea, así que corre sin aprobación.
- `calendar_list`, `calendar_add`, `calendar_update`, `calendar_remove` — el calendario compartido (ver [Tareas programadas](./10-scheduled-tasks.md)): el agente lee la agenda, agrega una nota libremente, y programa una acción, cambia o quita una entrada con tu aprobación.
- `youtube_transcript` — transcripción de un vídeo de YouTube, sin clave.
- `remember` — el agente guarda notas duraderas en su propia memoria (ver [Agentes](./05-agents.md)).
- `recall` — el agente busca en sus conversaciones pasadas, más allá del historial reciente.
- `delegate_task` — el agente le pasa una tarea a otro agente por su nombre; la respuesta aparece en el chat del otro (ver [Agentes](./05-agents.md)).

Cada tarjeta explica qué hace el suyo, y las integraciones con servicios externos (Telegram, GitHub) viven en [Herramientas](./09-tools.md).

Todos pasan por un **guard de seguridad** que bloquea rutas de credenciales, comandos catastróficos y peticiones a redes internas, y redacta secretos de los resultados. Más en [Seguridad](./13-security.md).

## Tus add-ons (`my_addons/`)

Puedes escribir herramientas propias: cada una es una carpeta dentro de `my_addons/` (en la carpeta de datos) con un pequeño módulo que exporta la herramienta. Se cargan **en caliente** — no hay que reiniciar nada — y aparecen en la vista Add-ons como "Personalizado".

Ojo: tus add-ons son código tuyo y se ejecutan sin restricción. Trátalos como tal.

Decile a HydraOps qué hace tu herramienta agregando un campo `risk` al objeto exportado: `{ readsExternal: true }` si devuelve texto escrito por terceros (una página, un feed, una bandeja de entrada), `{ sensitive: true }` si actúa o manda algo hacia afuera, o ambos. Una herramienta que no declara nada se trata como las dos cosas — la suposición segura. Ver [Seguridad](./13-security.md).

## Servidores MCP

MCP (Model Context Protocol) es el estándar para conectar herramientas de terceros por HTTP. En **Add-ons → Servidores MCP**, el botón **Editar JSON** abre la configuración:

```json
{
  "mcpServers": {
    "duckduckgo": {
      "url": "https://ejemplo.com/mcp",
      "headers": { "Authorization": "Bearer …" },
      "switch": "on"
    }
  }
}
```

Cada servidor tiene su interruptor, y la vista muestra su estado real según lo reportan los workers: Conectado, Conectando…, Error de conexión, Tiempo agotado, Apagado.

Los servidores empiezan a conectarse **cuando arranca la app**, no con la primera tarea. Cada worker conecta solo los servidores que usan sus agentes: uno que ningún agente tiene en sus herramientas no se arranca. Si uno no conectó (docker todavía levantando, la aplicación que maneja estaba cerrada), se **reintenta solo** en la tarea siguiente, como mucho una vez por minuto; y si un servidor avisa que perdió su conexión (cerraste y reabriste Blender, por ejemplo), HydraOps lo reinicia para que se reconecte. No hace falta tocar la configuración.

### Imágenes que devuelve una herramienta

Algunas herramientas responden con una imagen: una captura del visor de Blender, una captura de página de un servidor de navegador. Si el modelo del agente ve imágenes (los modelos de chat de OpenAI, Anthropic y Gemini, y otros cuyo nombre lo indica), la imagen se le muestra justo después del resultado de la herramienta, así puede comprobar de verdad su trabajo; las dos más recientes siguen adjuntas mientras dura la tarea. A un modelo que no ve imágenes se le dice claramente que no se le mostró, para que no afirme haberla mirado.

Con un modelo local, pon `LOCAL_LLM_VISION=1` en el `.env` si tu servidor tiene cargado el proyector multimodal. `HYDRA_TOOL_IMAGES=off` lo desactiva para todos los modelos y `all` lo fuerza.

### Qué hace cada herramienta (`toolRisk`)

> Para los servidores más comunes no hace falta escribir esto a mano: las [Conexiones](./09-tools.md) del catálogo ya traen el comando y la clasificación de cada herramienta.

Un servidor local que maneja una aplicación tuya (por `command`) también se configura acá. HydraOps no sabe qué hace cada herramienta de un servidor que no conoce, así que la trata como el peor caso: que **lee contenido de terceros y actúa**. Con eso, apenas el agente usa dos herramientas de ese servidor en una tarea, la segunda queda retenida para tu aprobación (ver [Seguridad](./13-security.md)), aunque solo esté leyendo. `toolRisk` le dice qué hace cada una:

```json
{
  "mcpServers": {
    "BlenderLab": {
      "command": "uvx",
      "args": ["--from", "git+https://projects.blender.org/lab/blender_mcp.git@2cea8d566dde07fbac28a61d698909d69724e853#subdirectory=mcp", "blender-mcp"],
      "toolRisk": {
        "get_objects_summary": "neutral",
        "get_object_detail_summary": "neutral",
        "get_screenshot_of_window_as_image": "neutral",
        "execute_blender_code": "acts"
      }
    }
  }
}
```

- `neutral`: ni lee contenido de terceros ni actúa (el estado de tu propia aplicación, la hora).
- `read`: trae contenido de terceros (una página, resultados de búsqueda); no cambia nada. Marca la tarea.
- `acts`: cambia algo (ejecuta código, escribe, envía). Se retiene si la tarea ya leyó contenido de terceros.
- `both`: las dos cosas.
- `approve`: cada llamada espera tu aprobación, haya leído lo que haya leído la tarea y con cualquier ajuste de seguridad (código que corre dentro de la aplicación, un menú que puede hacer cualquier cosa). *Aprobar por el resto de la tarea* no la cubre.

El nombre es el de la herramienta tal como la publica el servidor, sin el prefijo del servidor. Las que no listes siguen la regla de siempre: servidor conocido, anotación `readOnlyHint` del propio servidor, o el peor caso.

### Herramientas que tardan (`toolTimeoutSeconds`)

Una llamada a una herramienta de un servidor MCP tiene 30 segundos para responder. Alcanza para casi todas; un servidor cuyas herramientas esperan un trabajo largo (un render, la generación de una imagen o de un modelo 3D) necesita más, o cada llamada de esas se corta mientras el trabajo sigue. Poné `toolTimeoutSeconds` en la entrada de ese servidor, entre 30 y 3600:

```json
{
  "mcpServers": {
    "MiRender": {
      "command": "uvx",
      "args": ["my-render-server"],
      "toolTimeoutSeconds": 900
    }
  }
}
```

Vale para todas las herramientas de ese servidor y para ningún otro. Una conexión del catálogo que lo necesita ya trae su valor.

## Qué herramientas ve cada agente

Ninguna, hasta que se la concedas: una herramienta —nativa, add-on propio o servidor MCP— solo llega a un agente si su `tools.md` la nombra. Se gestiona con el selector de etiquetas de la vista Agentes (ver [Agentes](./05-agents.md)); los agentes nuevos vienen con `web_search`, `fetch_url`, `remember` y `recall` ya concedidas. Así tu agente de investigación puede tener buscador y tu agente de código no.

Además, cada add-on nativo tiene un interruptor global en esta vista: apagarlo aquí lo apaga para **todos** los agentes, diga lo que diga su `tools.md`.

# ¿Qué es HydraOps?

HydraOps es un sistema multi-agente de IA con interfaz de chat. Creas agentes —cada uno con su personalidad, su modelo y sus herramientas— y les mandas tareas por chat o programadas: escriben código, contestan preguntas, buscan en la web, generan imágenes y vídeo.

## Las piezas, en una pasada

- **Agentes.** Cada agente es una carpeta con seis archivos Markdown que definen quién es y qué sabe hacer. Los editas desde la propia interfaz. Ver [Agentes](./05-agents.md).
- **Workers.** Cuatro tipos de ejecutor: **código**, **general**, **imagen** y **vídeo**. Cada agente pertenece a uno, y eso decide qué clase de tareas resuelve.
- **Modelos.** Funciona con modelos de API (OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax, OpenRouter, Leonardo) y con modelos locales por cualquier servidor compatible con OpenAI — llama.cpp, LM Studio, vLLM, Ollama. Ver [Claves de API y modelos](./04-api-keys.md).
- **Add-ons.** Add-ons nativos, add-ons tuyos y servidores MCP: lo que los agentes usan para *hacer*. Ver [Add-ons y MCP](./08-addons.md).
- **Herramientas.** Telegram y GitHub para manejar los agentes desde fuera; las **Skills**, procedimientos probados que los agentes abren cuando una tarea los necesita; y las **Conexiones**, un catálogo de servidores MCP listos para instalar (Blender, un navegador real, documentos) donde cada herramienta dice qué hace. Ver [Herramientas (integraciones)](./09-tools.md).
- **Comandos.** Escribe `/` en el chat: verbos que no gastan tokens, y **`/plan`** para que el agente proponga un plan que apruebas, editas o revisas antes de que se ejecute nada. Ver [Comandos](./15-commands.md) y [El chat](./06-chat.md#planificar-antes-de-hacer).
- **Seguridad.** Lo que un agente lee de afuera se trata como dato, nunca como instrucciones, y cuando una tarea ya leyó contenido externo las acciones que cambian algo esperan tu aprobación. Ver [Seguridad](./13-security.md).
- **Tareas programadas.** Crons: "cada mañana a las 8, resume las novedades de…". Ver [Tareas programadas](./10-scheduled-tasks.md).
- **Complementos.** Mini-aplicaciones dentro de la interfaz: **One Shot**, que compila un diagrama de flujo en un prompt de un tiro, y **3D**, donde un modelo escribe la escena que describes y la ves renderizada. Ver [Complementos](./07-plugins.md).

## Cómo fluye una tarea

Escribes un mensaje en el chat → la tarea se guarda y se asigna a un agente → el worker de ese agente la ejecuta con su modelo y sus herramientas → el resultado aparece en el chat. Todo pasa por una cola de eventos interna, así que puedes encadenar tareas sin esperar a que termine la anterior.

## Dos formas de usarlo

- **Escritorio (Windows).** Un instalador normal; la aplicación abre su ventana y levanta todo por dentro. Ver [Instalación](./02-installation.md).
- **Servidor (headless).** Un solo comando levanta la pila en una máquina sin pantalla —un mini PC en casa, por ejemplo— y la usas desde el navegador de cualquier equipo de tu red. Ver [Modo servidor](./12-server-mode.md).

## Dónde están tus datos

Tus agentes, mensajes, adjuntos y ajustes viven **fuera** del directorio de instalación (en Windows, `%APPDATA%\HydraOps`), así que actualizar o reinstalar la aplicación no toca nada tuyo. Las claves de API van aparte, en un almacén propio — ver [Seguridad](./13-security.md).

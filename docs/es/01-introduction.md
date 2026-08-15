# ¿Qué es HydraOps?

HydraOps es un sistema multi-agente de IA con interfaz de chat. Creas agentes —cada uno con su personalidad, su modelo y sus herramientas— y les mandas tareas por chat o programadas: escriben código, contestan preguntas, buscan en la web, generan imágenes y vídeo.

## Las piezas, en una pasada

- **Agentes.** Cada agente es una carpeta con seis archivos Markdown que definen quién es y qué sabe hacer. Los editas desde la propia interfaz. Ver [Agentes](./05-agents.md).
- **Workers.** Cuatro tipos de ejecutor: **código**, **general**, **imagen** y **vídeo**. Cada agente pertenece a uno, y eso decide qué clase de tareas resuelve.
- **Modelos.** Funciona con modelos de API (OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax, OpenRouter, Leonardo) y con modelos locales por cualquier servidor compatible con OpenAI — llama.cpp, LM Studio, vLLM, Ollama. Ver [Claves de API y modelos](./04-api-keys.md).
- **Herramientas.** Add-ons nativos, add-ons tuyos y servidores MCP. Ver [Add-ons y MCP](./07-addons.md).
- **Tareas programadas.** Crons: "cada mañana a las 8, resume las novedades de…". Ver [Tareas programadas](./08-scheduled-tasks.md).

## Cómo fluye una tarea

Escribes un mensaje en el chat → la tarea se guarda y se asigna a un agente → el worker de ese agente la ejecuta con su modelo y sus herramientas → el resultado aparece en el chat. Todo pasa por una cola de eventos interna, así que puedes encadenar tareas sin esperar a que termine la anterior.

## Dos formas de usarlo

- **Escritorio (Windows).** Un instalador normal; la aplicación abre su ventana y levanta todo por dentro. Ver [Instalación](./02-installation.md).
- **Servidor (headless).** Un solo comando levanta la pila en una máquina sin pantalla —un mini PC en casa, por ejemplo— y la usas desde el navegador de cualquier equipo de tu red. Ver [Modo servidor](./10-server-mode.md).

## Dónde están tus datos

Tus agentes, mensajes, adjuntos y ajustes viven **fuera** del directorio de instalación (en Windows, `%APPDATA%\HydraOps`), así que actualizar o reinstalar la aplicación no toca nada tuyo. Las claves de API van aparte, en un almacén propio — ver [Seguridad](./11-security.md).

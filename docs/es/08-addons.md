# Add-ons y MCP

Las herramientas son lo que separa a un agente que *contesta* de uno que *hace*. En HydraOps hay tres clases, y las tres se gestionan desde la vista **Add-ons**.

![La vista Add-ons: nativos, propios y servidores MCP](../img/es/addons.png)

## Add-ons nativos

Vienen con la aplicación. Hoy son:

- `web_search` — buscar en la web (DuckDuckGo, sin clave).
- `brave_search` — búsqueda con la API de Brave; la clave se pega en su tarjeta y viaja por el key-proxy.
- `fetch_url` — descargar y leer una página.
- `youtube_transcript` — transcripción de un vídeo de YouTube, sin clave.
- `remember` — el agente guarda notas duraderas en su propia memoria (ver [Agentes](./05-agents.md)).
- `recall` — el agente busca en sus conversaciones pasadas, más allá del historial reciente.

Cada tarjeta explica qué hace el suyo, y las integraciones con servicios externos (Telegram, GitHub) viven en [Herramientas](./09-tools.md).

Todos pasan por un **guard de seguridad** que bloquea rutas de credenciales, comandos catastróficos y peticiones a redes internas, y redacta secretos de los resultados. Más en [Seguridad](./13-security.md).

## Tus add-ons (`my_addons/`)

Puedes escribir herramientas propias: cada una es una carpeta dentro de `my_addons/` (en la carpeta de datos) con un pequeño módulo que exporta la herramienta. Se cargan **en caliente** — no hay que reiniciar nada — y aparecen en la vista Add-ons como "Personalizado".

Ojo: tus add-ons son código tuyo y se ejecutan sin restricción. Trátalos como tal.

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

## Qué herramientas ve cada agente

Ninguna, hasta que se la concedas: una herramienta —nativa, add-on propio o servidor MCP— solo llega a un agente si su `tools.md` la nombra. Se gestiona con el selector de etiquetas de la vista Agentes (ver [Agentes](./05-agents.md)); los agentes nuevos vienen con `web_search`, `fetch_url`, `remember` y `recall` ya concedidas. Así tu agente de investigación puede tener buscador y tu agente de código no.

Además, cada add-on nativo tiene un interruptor global en esta vista: apagarlo aquí lo apaga para **todos** los agentes, diga lo que diga su `tools.md`.

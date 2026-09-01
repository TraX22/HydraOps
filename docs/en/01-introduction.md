# What is HydraOps?

HydraOps is a multi-agent AI system with a chat interface. You create agents — each with its own personality, model and tools — and send them tasks by chat or on a schedule: they write code, answer questions, search the web, generate images and video.

## The pieces, in one pass

- **Agents.** Each agent is a folder with six Markdown files defining who it is and what it knows how to do. You edit them from the interface itself. See [Agents](./05-agents.md).
- **Workers.** Four executor types: **code**, **general**, **image** and **video**. Every agent belongs to one, and that decides what kind of tasks it handles.
- **Models.** Works with API models (OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax, OpenRouter, Leonardo) and with local models through any OpenAI-compatible server — llama.cpp, LM Studio, vLLM, Ollama. See [API keys & models](./04-api-keys.md).
- **Add-ons.** Native add-ons, your own add-ons and MCP servers: what the agents use to *act*. See [Add-ons & MCP](./08-addons.md).
- **Tools.** Connectors to external services, like Telegram to run your agents from your phone. See [Tools (integrations)](./09-tools.md).
- **Scheduled tasks.** Crons: "every morning at 8, summarize the news from…". See [Scheduled tasks](./10-scheduled-tasks.md).
- **Plugins.** Mini-apps inside the interface; today **One Shot**, which compiles a flow diagram into a one-shot prompt. See [Plugins & One Shot](./07-one-shot.md).

## How a task flows

You write a message in the chat → the task is stored and assigned to an agent → that agent's worker executes it with its model and tools → the result shows up in the chat. Everything goes through an internal event queue, so you can chain tasks without waiting for the previous one to finish.

## Two ways to use it

- **Desktop (Windows).** A regular installer; the application opens its window and brings everything up inside. See [Installation](./02-installation.md).
- **Server (headless).** A single command brings up the stack on a machine with no screen — a mini PC at home, for example — and you use it from the browser of any device on your network. See [Server mode](./12-server-mode.md).

## Where your data lives

Your agents, messages, attachments and settings live **outside** the installation directory (on Windows, `%APPDATA%\HydraOps`), so updating or reinstalling the application never touches anything of yours. API keys go separately, into their own store — see [Security](./13-security.md).

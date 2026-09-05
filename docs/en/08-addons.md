# Add-ons & MCP

Tools are what separate an agent that *answers* from one that *does*. HydraOps has three kinds, all managed from the **Add-ons** view.

![The Add-ons view: native, custom and MCP servers](../img/en/addons.png)

## Native add-ons

They ship with the application. Today they are:

- `web_search` — search the web (DuckDuckGo, no key needed).
- `brave_search` — search with the Brave API; the key is pasted on its card and travels through the key-proxy.
- `fetch_url` — download and read a page.
- `youtube_transcript` — transcript of a YouTube video, no key needed.
- `remember` — the agent saves durable notes to its own memory (see [Agents](./05-agents.md)).
- `recall` — the agent searches its past conversations, beyond the recent history.

Each card explains what its add-on does, and the integrations with external services (Telegram, GitHub) live in [Tools](./09-tools.md).

All of them go through a **security guard** that blocks credential paths, catastrophic commands and requests to internal networks, and redacts secrets from results. More in [Security](./13-security.md).

## Your add-ons (`my_addons/`)

You can write your own tools: each is a folder inside `my_addons/` (in the data folder) with a small module exporting the tool. They are **hot-loaded** — nothing to restart — and appear in the Add-ons view as "Custom".

Careful: your add-ons are your code and run unrestricted. Treat them as such.

## MCP servers

MCP (Model Context Protocol) is the standard for connecting third-party tools over HTTP. In **Add-ons → MCP servers**, the **Edit JSON** button opens the configuration:

```json
{
  "mcpServers": {
    "duckduckgo": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" },
      "switch": "on"
    }
  }
}
```

Every server has its own switch, and the view shows its real status as reported by the workers: Connected, Connecting…, Connection error, Timed out, Off.

## Which tools each agent sees

None, until you grant them: a tool — native, custom add-on or MCP server — reaches an agent only if its `tools.md` names it. It's managed with the tag selector in the Agents view (see [Agents](./05-agents.md)); new agents come with `web_search`, `fetch_url`, `remember` and `recall` already granted. That way your research agent can have a web search tool while your coding agent doesn't.

On top of that, every native add-on has a global switch in this view: turning it off here turns it off for **every** agent, whatever its `tools.md` says.

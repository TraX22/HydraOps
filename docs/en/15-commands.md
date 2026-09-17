# Commands

Commands are verbs over HydraOps typed in the chat box, starting with `/`. No model is involved: they are immediate, deterministic and cost no tokens. Anything that needs a model is still a normal message to the agent.

Typing `/` opens the palette with the commands and agents matching what you type. Arrow keys to move, Tab or Enter to complete, Enter to run. The result shows up in the chat as a system note: it is not stored and never sent to an agent.

The same commands work in the Telegram bot. Those that only make sense with the interface (`/oneshot`, `/close`) answer there with a notice.

## Chat and agents

| Command | What it does |
|---|---|
| `/help [command]` | List the commands; with a name, explain that one. |
| `/agents` | Agents with their status, worker and model. |
| `/use <agent>` | Open that agent's chat and make it the active one. |
| `/<agent> <message>` | Send a message to that agent **without switching tabs**. The reply appears in that agent's chat. |
| `/main` | Back to the main chat. |
| `/close` | Close the current tab. |
| `/delegate <agent> <task>` | Create a task for another agent, from wherever you are. |
| `/tasks` | Latest tasks of this chat with their status. |

## Active agent's memory

| Command | What it does |
|---|---|
| `/remember <note>` | Save a note to the agent's permanent memory, no model involved. |
| `/recall <keywords>` | Search the agent's past conversations. |
| `/memory` | Show the agent's memory file. |

These three need an agent chat open: the main chat has no "active agent".

## System

| Command | What it does |
|---|---|
| `/status` | Version, services with a heartbeat and providers with a key. |
| `/keys` | Which providers have a key configured (never the values). |
| `/telegram <text>` | Send that text to your Telegram. |
| `/oneshot` | Open the One Shot canvas. |
| `/3d` (`/threed`, `/objeto3d`) | Open the 3D plugin. |
| `/whoami` | Who you are and which agent is active. |

Spanish aliases exist for most commands (`/agentes`, `/usar`, `/tareas`, `/estado`, `/recordar`…); `/help` lists them.


## Quick configuration of the active agent

| Command | What it does |
|---|---|
| `/model [name]` | Without an argument shows the agent's LLM; with one, changes it (partial names accepted). |
| `/engine [name \| auto]` | The agent's image or video engine (graphic and video workers only). |
| `/aspect <16:9 \| 9:16 \| …>` | Image or video aspect ratio; only the ones the chosen engine supports. |
| `/tools` | Tools granted to the agent. |
| `/grant <tool>` · `/revoke <tool>` | Add or remove the line in the agent's `tools.md`. |
| `/profile` | Open the agent's profile. |

## Scheduled tasks

| Command | What it does |
|---|---|
| `/crons` | List the scheduled tasks with a readable schedule. |
| `/cron <schedule> <prompt>` | Schedule a task for the active agent. In the app it opens the form pre-filled for confirmation; in Telegram it creates it directly. |
| `/pause <name>` · `/resume <name>` | Pause or resume a task by name. |
| `/run <name>` | Run it now, without waiting for its schedule. |

Schedules `/cron` understands: `5m`, `every 30 min`, `hourly`, `hourly :15`, `09:00`, `daily 21:30`, `mon-fri 09:00`, `mon,wed,fri 18:00`, `monthly 1 08:00`, `noon`, `midnight`, or a five-field cron expression.

## Other

| Command | What it does |
|---|---|
| `/retry` | Send this chat's last message again. |
| `/lang <es \| en \| it \| fr \| pt>` | Switch the interface language. |
| `/theme <light \| dark>` | Switch the theme. |

## Tips

- `/delegate` and `/<agent> …` create the task as if you had typed it in that agent's chat: the agent shows a green dot until you open its chat.
- Agents can also hand work to each other with the `delegate_task` tool, when granted in their `tools.md`. See [Agents](./05-agents.md).

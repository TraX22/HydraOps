# Tools (integrations)

The **Tools** section in the sidebar connects HydraOps to external services. Don't confuse it with [Add-ons](./08-addons.md): an add-on is a tool the *agents use* (search the web, read a page); a tool in this section is a **connector** that lets you *operate HydraOps from the outside*.

Today there are **Telegram** (talk to your agents from your phone), **GitHub** and **[Skills](#skills-know-how-for-the-agents)**, the know-how agents read when a task calls for it. Discord, Signal and Reddit appear as "coming soon".

## Telegram: run your agents from your phone

With the Telegram bot you message an agent from your phone and get its reply, just like the chat inside the app.

### 1. Create the bot on Telegram

In Telegram, open a chat with **@BotFather** (the official bot that creates bots) and send `/newbot`. Follow the steps (a name and a username ending in `bot`). When it's done it gives you a **token** like this:

```
123456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

BotFather also gives you the link to your bot (`t.me/YourBot`). Keep it: that's where **you** will type, not in the BotFather chat.

### 2. Configure it in HydraOps

Go to **Tools → Telegram** and:

1. **Paste the token** in the field and press **Save**. The badge turns to "Token set". The token goes to an encrypted store outside the project — never to the repository, the database or any `.env` (see [Security](./13-security.md)).
2. **Pick a default agent** (optional): with one set, plain messages go to that agent without having to name it.
3. **Generate a pairing code** with the button. It's a short number that authorizes whoever uses it.
4. **Enable** the toggle (ON). The bot starts listening within seconds, no restart needed.

### 3. Link your phone

Open **your** bot in Telegram (the `t.me/…` link from BotFather) and send:

```
/start <pairing code>
```

If the code matches, your account is authorized and you can talk to the agents. Anyone who isn't authorized can only try to pair: without a valid code, the bot ignores their messages.

### Commands

The bot uses **the same commands as the app's chat** (see [Commands](./15-commands.md)): `/agents`, `/use <agent>`, `/delegate`, `/tasks`, `/status`, `/remember`, `/recall`, `/crons`, `/cron`, `/pause`, `/resume`, `/run`, `/model`, `/tools`, `/grant`… with their Spanish aliases. Those that only make sense with the interface (`/oneshot`, `/close`, `/profile`, `/lang`, `/theme`) answer with a notice.

| You type | What happens |
|---|---|
| `/<agent> <message>` | Sends a one-off message to that agent (e.g. `/elena summarize this`) and the bot relays the reply. |
| `/use <agent>` | Sets this Telegram chat's active agent. |
| *plain text* | Goes to the active agent (or the default agent). |
| `/help` | Lists every command. |

Code comes back in a monospace frame, so a "hello world" asked of a coding agent reads cleanly on the phone.

### Access control

Since the bot is reachable by anyone who knows its username, access is controlled with an **allowlist** (the Telegram ids allowed to use it) plus the **pairing code**. You can edit the list by hand from the card — add or remove ids — and regenerate the code whenever you want; regenerating it stops the old one from pairing new users.

### Where the bot runs

The bot is just another service in the stack: it starts with the desktop app and with [server mode](./12-server-mode.md). For it to answer around the clock — from your phone, away from home — you'll want HydraOps running 24/7 on a server machine. Like every service, it shows up in the **System** view and writes its log to `storage/logs/telegram-bot.log`.

## Skills: know-how for the agents

A **skill** is a written procedure for one kind of work: how to do in-depth research, how to write a thread for X, how to audit a page's SEO. It is a folder with a `SKILL.md` file (the open [Agent Skills](https://agentskills.io) format, shared with other assistants) and sometimes reference files or templates.

Skills are **global**: installed once and used by every agent allowed to. An agent does not load the full text on every task: it sees only the name and description of each installed skill and opens the right one when a request matches. That keeps the prompt short, which local models notice.

### Per-agent permissions

Granted in each agent's **Agents → Tools**, like Telegram or web search:

| Tool | What it allows |
|---|---|
| `skills` | Seeing and using the installed skills. |
| `create_skill` | Proposing new skills. |

An agent without `create_skill` cannot create skills, even if it uses the existing ones. The **Skills** card shows which agents have each permission, and its **ON/OFF** button turns skills off for everyone.

### Installing from the catalog

The **Available** table reads the official catalog, the public [HydraOps-Skills](https://github.com/TraX22/HydraOps-Skills) repository. Each skill has a **View** button that shows its files and a **safety scan** before you install it: it flags phrases that try to take over the agent, credential file names, "download and run" commands, hidden text, or anything that looks like a key. **⬇ Install** downloads it and checks every file against the catalog's index; if they don't match, nothing is installed. When the catalog has a new version of an installed skill, **Update** appears, and **⟳ Check for updates** asks the catalog again.

Skills are text: HydraOps **never runs** any scripts a skill may include.

### Installing by hand

You can also copy a skill by hand: the whole folder (with its `SKILL.md`) into the skills folder of your data:

| Setup | Folder |
|---|---|
| Windows (installed app) | `%APPDATA%\HydraOps\data\skills\` |
| macOS | `~/Library/Application Support/HydraOps/data/skills/` |
| Linux | `~/.config/HydraOps/data/skills/` |
| From source | `skills/` at the repository root |

The exact path is shown at the bottom of the card. The folder name must match the `name` in `SKILL.md` (lowercase letters, digits and hyphens). Skills copied by hand show as *copied by hand* and are deleted like any other.

### Skills the agents create

An agent with `create_skill` can propose a skill when it has worked out something worth repeating. The proposal **is not saved on its own**: it is held with an **Approve / Reject** card in the chat, in the **Installed** table (marked *awaiting approval*) and, if Telegram is set up, on your phone. Read all of it before approving: it will become instructions for every agent that uses skills.

Skills your agents create stay **on your computer**: they are not uploaded to any repository. An agent cannot change or replace a skill that already exists either.

Skills cannot be edited from the app yet: to change one, edit its `SKILL.md` in the folder, or delete it and install it again.

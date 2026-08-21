# Tools (integrations)

The **Tools** section in the sidebar connects HydraOps to external services. Don't confuse it with [Add-ons](./07-addons.md): an add-on is a tool the *agents use* (search the web, read a page); a tool in this section is a **connector** that lets you *operate HydraOps from the outside*.

The first — and for now the only — one is **Telegram**: talk to your agents from your phone. GitHub, Discord, Signal and Reddit appear as "coming soon".

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

1. **Paste the token** in the field and press **Save**. The badge turns to "Token set". The token goes to an encrypted store outside the project — never to the repository, the database or any `.env` (see [Security](./12-security.md)).
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

| Command | What it does |
|---|---|
| `/agents` | Lists the available agents. |
| `/<agent> <message>` | Sends a one-off message to that agent (e.g. `/elena summarize this`). |
| `/use <agent> [message]` | Sets the chat's active agent; if you add a message, it switches **and** sends it. |
| *plain text* | Goes to the active agent (or the default agent). |
| `/help` | Shows the help. |
| `/whoami` | Shows your id and the active agent. |

Code comes back in a monospace frame, so a "hello world" asked of a coding agent reads cleanly on the phone.

### Access control

Since the bot is reachable by anyone who knows its username, access is controlled with an **allowlist** (the Telegram ids allowed to use it) plus the **pairing code**. You can edit the list by hand from the card — add or remove ids — and regenerate the code whenever you want; regenerating it stops the old one from pairing new users.

### Where the bot runs

The bot is just another service in the stack: it starts with the desktop app and with [server mode](./11-server-mode.md). For it to answer around the clock — from your phone, away from home — you'll want HydraOps running 24/7 on a server machine. Like every service, it shows up in the **System** view and writes its log to `storage/logs/telegram-bot.log`.

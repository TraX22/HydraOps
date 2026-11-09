# Tools (integrations)

The **Tools** section in the sidebar connects HydraOps to external services. Don't confuse it with [Add-ons](./08-addons.md): an add-on is a tool the *agents use* (search the web, read a page); a tool in this section is a **connector** that lets you *operate HydraOps from the outside*.

Today there are **Telegram** (talk to your agents from your phone), **GitHub**, **[Hugging Face](#hugging-face-models-datasets-and-spaces)** (models, datasets and Spaces), **[Civitai](#civitai-models-trigger-words-and-example-settings)** (models, trigger words and example settings), **[Skills](#skills-know-how-for-the-agents)** (the know-how agents read when a task calls for it), **[Connections](#connections-ready-made-mcp-servers)** (apps and services the agents can drive) and **[X](#x-your-accounts-posted-to-with-your-approval)** (your X accounts). Discord, Signal and Reddit appear as "coming soon".

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

1. **Paste the token** in the field and press **Save**. The badge turns to "Token set". The token goes to HydraOps' encrypted key store outside the project — never to the repository, the database or any `.env` (see [Security](./13-security.md)).
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

An agent without `create_skill` cannot create skills, even if it uses the existing ones. Agents with `create_skill` always get the **skill-creator** guide, which is included with HydraOps: it needs no install, cannot be deleted, and teaches them to write a skill in the right format. The **Skills** card shows which agents have each permission, and its **ON/OFF** button turns skills off for everyone.

### Installing from the catalog

The **Available** table reads the official catalog, the public [HydraOps-Skills](https://github.com/TraX22/HydraOps-Skills) repository. Each skill has a **View** button that shows its files and a **safety scan** before you install it: it flags phrases that try to take over the agent, credential file names, "download and run" commands, hidden text, or anything that looks like a key. **⬇ Install** downloads it and checks every file against the catalog's index; if they don't match, nothing is installed. When the catalog has a new version of an installed skill, **Update** appears, and **⟳ Check for updates** asks the catalog again.

Skills are text: HydraOps **never runs** any scripts a skill may include.

### Installing from GitHub

Any public GitHub repository that keeps skills in the same open format (a folder with a `SKILL.md`) is a source too: Unity's official skills, the lists the community maintains, a repository of your own. Paste its address in **Install from GitHub** and press **See what it holds**: the repository, one folder of it, or the `SKILL.md` itself (`https://github.com/owner/repo/tree/main/skills/my-skill`). Nothing is installed yet: HydraOps reads the repository and shows what it holds.

- A repository with many skills lists them with their description, files and size; copies kept for other agents under hidden folders (`.gemini/`, `.codex/`…) are left out, and a skill whose name you already have installed from elsewhere is marked. Pick the ones you want.
- One skill shows the summary: name, description, author and version from its `SKILL.md`, the repository's license and the one the skill declares, the files that will be installed and the ones that will not (an image, a file over the size limit), the **safety scan**, and a warning when the skill was written for an agent with a terminal: in HydraOps the agent translates those commands into the tools of its connections, and the ones that run code wait for your approval. You can read the whole `SKILL.md` before confirming.
- Source code a skill ships (`.cs`, `.cpp`, `.hlsl`, `.js`…) is installed as **read-only text**: the agent can open it as reference; HydraOps never compiles or runs it.

The installed skill keeps its origin: repository, branch or tag, commit and folder. Opening the Skills view asks GitHub, once per repository, whether that folder has moved on. The row always has a button for that skill: **Update**, in green, when the folder has moved on since you installed it; **Up to date** otherwise. Pressing it asks the repository again; when there is something new it reinstalls the skill from the same place, after the safety scan runs again, and in both cases the answer appears under the row ("updated · commit" or "up to date · commit"). GitHub allows 60 of those questions an hour per computer without a token; a preview spends three, and viewing or installing what was just previewed spends none (the answers are kept for a few minutes).

HydraOps redistributes nothing: the skill comes from its author's repository, under the license the repository and the skill declare, and the preview shows both so you can decide.

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

## Tools on demand

Every call to the model carries the definitions of the tools the agent may use, and with a couple of connections that is tens of thousands of tokens even when the request is one line. So when an agent has **more than 12 tools**, HydraOps does not send the definitions: it sends an index, the name and one line per tool grouped by connection, plus one more tool, `load_tools`, with which the model loads the full definition of the ones it is going to use in its next step.

To spare that loading round in the obvious cases, these start loaded:

- the tools you name in the message, by the connection's name ("Blender", "Comfy") or by the tool's own name ("run workflow");
- the ones the same chat used in its previous task;
- the calls a task resumes after an approval.

A loaded tool stays loaded for the rest of the task, called or not: the list of tools is the first thing in every request, and any change to it makes the provider read the whole conversation again at the full price instead of from its cache, which costs far more than a few idle definitions. The `load_tools` round does not count toward the agent's step limit. Approvals, the injection defense and the result vault work as before: only what the model sees before choosing changes. What each task loaded is kept with its data (`toolsOnDemand`).

It can be turned off in **Settings → Tools on demand** (or with `TOOLS_ON_DEMAND=off`). With 12 tools or fewer nothing changes.

## X: your accounts, posted to with your approval

HydraOps connects to **your own X developer app**, and through it to as many of your X accounts as you like: a project's, a brand's, a personal one. The agents read them and search X with the `x_read` and `x_search` tools, and publish on them with `x_post`. Every post waits for your approval; every read costs money, within a budget you set.

### 1. Your callback page

When you authorise an account, X sends the browser back to a **Callback URI** registered in your app, and X only takes **https** addresses there (not `localhost`, not `127.0.0.1`). HydraOps runs on your own computer, so the callback is a small page you host yourself: it receives the browser and forwards it to the HydraOps on that same computer (`http://127.0.0.1:3000`). It stores nothing and talks to no server; the code it carries is useless without the secret check HydraOps keeps.

Do this once:

1. In **Tools → X** press **Download the page**: you get an `index.html`. Reading this outside HydraOps? The same file is in the repository, [`ui/public/x-callback.html`](https://github.com/TraX22/HydraOps/blob/main/ui/public/x-callback.html) (use GitHub's download button and rename it `index.html`).
2. Publish it on any hosting with https. The example below uses **GitHub Pages**, which is free; any other hosting, free or paid, with its own domain or a free subdomain (Cloudflare Pages, Netlify, Vercel, your own website), works exactly the same: what counts is the final https address.
3. Write down the address where the page opens: that is your **Callback URI**.

With GitHub Pages:

1. Create a **public** repository, for example `x-callback`.
2. Upload the file inside the folders `x/callback/` (so the path is `x/callback/index.html`). Any folder works; this one makes the address easy to recognise.
3. In the repository's **Settings → Pages** choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the page is at `https://<your-user>.github.io/x-callback/x/callback/`. That is your Callback URI, with the final slash.

Keep the host from logging full addresses if it lets you: the one-time code travels in the address (it expires in seconds and works only once, but it is better not kept anywhere).

### 2. Create the app in X's portal

X's API is pay-per-use: there is no free tier for new developers, you load credits in the portal and every operation deducts a little (about 0.015 USD per post, 0.20 USD when the post carries a link, 0.005 USD per post read, at the time of writing). One developer account and one balance serve every account you connect.

1. Sign up at [developer.x.com](https://developer.x.com/) with the X account that will own the app, create a project and an app, and load credits. The environment (Development, Staging, Production) is only a label: choose Production for the app you will use.

   ![Creating the app in X's developer console](../img/x-console-create-app.png)

2. In the app's **User authentication settings** choose **Read and write** (or **Read and write and Direct message** if the agents will read and send direct messages; it can be changed later, and the accounts are then connected again), the **Web App, Automated App or Bot** type, put your **Callback URI** from step 1 and a website address (your page's site works), and **save the changes**.

   ![User authentication settings: Web App type and the Callback URI of a GitHub Pages copy of the page](../img/x-console-auth-settings.png)

3. Copy the **Client ID** and the **Client Secret** (shown once).

   ![X shows the Client ID and the Client Secret once (masked here)](../img/x-console-keys.png)

4. In **Tools → X** paste the Client ID, the Client Secret and the **same Callback URI**, character for character (the final slash included), and press **Save**. They go to HydraOps' key store, never to the database or the repository.

The Callback URI saved in HydraOps must be exactly the one registered in the app you took the Client ID from: if they differ, X answers "Something went wrong" when you authorise.

### 3. Connect each account

Press **Connect an account** and tick what the agents will use it for: **Read** (always on: profile, posts, mentions, searches, metrics), **Publish**, **Engage** (like, repost, bookmark, follow, mute, block) and **Messages** (direct messages). HydraOps asks X for the permissions of those uses only, so the account can never be used for anything else, whatever a model says. Then press **Get the link**: open it in a browser **on this computer**, signed in to X as the account you want to connect (switch accounts in X first if another one is open), accept the permissions HydraOps asks for, press **Continue** on your callback page and come back: the account appears in the list within seconds, with its tokens in the key store, refreshed on their own.

When HydraOps runs on a server and your browser is elsewhere, the callback cannot reach it: your callback page shows the address with a **Copy** button, and the card has a field to paste it in. Same result.

Each account's row shows its uses as chips. Switch one off there whenever you like; to add one, the account is **connected again** with that permission ticked (the row offers it), because X grants permissions only at sign-in. **Messages** needs the app at the Direct message level (step 2); otherwise X grants the rest and the card says what was left out. An account can be connected again at any time (its tokens are replaced), and **Disconnect** forgets it.

### 4. Who may use which account

Each connected account lists the agents allowed to use it (to read as it, to post on it), and a new account starts with **nobody**: the tools refuse, on the server side, any account the agent was not given here, so a post cannot land on the wrong brand by a model's mistake. Add agents with the picker on the account's row; the ON/OFF switch at the top pauses every account at once.

### 5. Posting

Give the agent the tools in the Agents view (its tools list, like any other tool; one line `x` gives it all of them) and the account in Tools → X. Then ask it for a post or a thread as you would ask a person: "announce the 0.2 release on the HydraOps account, three posts, the link in the last one". For posting the agent has:

- `x_accounts` lists the accounts it may use, what each was connected for and where its spending stands. With one account, it uses it; with several and a request that does not say which, it asks you; with none, it says so.
- `x_post` publishes one post or a thread (every part a reply to the one before) on one account, with attachments per part: up to 4 images, or one GIF, or one video (the files you dropped into the chat, by name; an MP4 with H.264 video and AAC audio, such as the ones ComfyUI makes). A video is uploaded in pieces and X processes it before the post goes out, so a post with a video takes minutes. The first part may be a **reply** to a post (`reply_to`, its id: the way to answer a mention), **quote** one (`quote`), carry a **poll** (2 to 4 options, 5 minutes to 7 days; no attachments on that part) and say **who may reply** (`reply_settings`: everyone, accounts it follows, mentioned accounts, subscribers, verified). It is held **every time**, whatever the task read: nothing goes out under your name without you. With `publish_at` (a date and time, with a time zone) the post is scheduled instead: approved once, it goes out at that time exactly as shown, through the calendar (see [Scheduled tasks](./10-scheduled-tasks.md#the-calendar)).

The approval card shows the account with its avatar, every part as it will be published with its character count (280 weighted characters, a link counting as 23; 25,000 on an account you marked **X Premium** in the card), the images or the video, what goes with the first part (the post it replies to or quotes, the poll, who may reply), and the estimated cost; so does the Telegram notice. **Approve** publishes and the agent answers with the link; **Reject** drops it and the agent is told. There is no "approve for the rest of the task" for a post: each one asks.

The server publishes only the exact post you approved (same agent, account, parts and extras), once; and it refuses, before anything reaches X, a part that is empty or over the limit, an account the agent was not given, an attachment that is not one of your files or is over X's size (5 MB for an image, 15 MB for a GIF, 8 GB for a video, 16 GB on a Premium account), a video or GIF mixed with other attachments, and anything while the switch is OFF.

### 6. Reading: mentions, posts, profiles and searches

Reading changes nothing on X, so it is not held for approval; but X charges for it, so it is kept in check with money instead. Two tools:

- `x_read` reads as one account: `mentions` (posts that mention it; with `since_id`, only the new ones), `my_posts`, `home` (its timeline), `user` (a profile), `user_posts`, `post`, `metrics` (one of its own posts with the impressions and clicks only the author sees), `thread` (the replies to a post, last 7 days), `quotes`, `likers`, `reposters`, `liked` and `bookmarks` (the last two need **Engage**). It returns 20 items by default; the agent asks for more with `limit`, or continues with `page`.
- `x_search` searches X: `recent` (last 7 days), `all` (the full archive, when your X plan allows it) and `counts_recent` / `counts_all` (how many posts matched per day, hour or minute, without the posts: the cheap way to measure). It takes X's query syntax (`from:`, `to:`, `#tag`, `"exact phrase"`, `-term`, `lang:es`, `is:reply`, `has:media`, `OR`…) and a date range.

Every answer ends with what the call cost and where the money stands. The estimate uses X's published price list: about 0.001 USD per own post or mention, 0.005 USD per other post, 0.010 USD per profile, 0.005 USD per count request; X's portal has the real figure. Two limits apply, both in the card:

- the **read budget per task** (0.50 USD unless you change it): once a task has spent it, further reads are refused and the agent is told to work with what it has, or to ask you;
- the **monthly cap per account**, empty by default: what the account has spent this month (reads and posts) is shown with a bar, and when the cap is reached nothing more goes out as that account until next month or until you raise it.

What comes back from X was written by other people, so it reaches the agent marked as outside content, like a web page: a mention or a reply that tells the agent to do something is reported to you, not obeyed, and a sensitive action after it waits for your approval (see [Security](./13-security.md)).


### 7. Engaging and following

Two more tools act under the account's name, and each action waits for your approval like a post does; unlike a post, **Approve for the rest of the task** works here, so "like these five posts" asks once. The account needs the **Engage** permission (deleting a post, **Publish**).

- `x_engage` acts on a post by its id: `like`, `unlike`, `repost`, `unrepost`, `bookmark`, `unbookmark`, `delete` (one of the account's own posts), `hide_reply` and `unhide_reply` (a reply to one of the account's posts).
- `x_users` deals with other users, by handle or id: `follow`, `unfollow`, `block`, `unblock`, `mute`, `unmute` (held), and the reads `followers`, `following`, `blocked`, `muted` (the account's own) and `user_followers`, `user_following` (another user's; not held, they cost like any read and come back as outside content).

The card and the Telegram notice say what the agent wants to do, to which post or user, as which account, and X's price for it (about 0.015 USD for a like, repost or follow; 0.005 to 0.010 to undo, bookmark or delete). The server runs only the exact call you approved (or a later call of a tool you approved for the rest of that task), once, and the account's monthly cap counts these too.


### 8. Listening for mentions

An account can be watched: switch **Listen for mentions** on in its row, choose which of its agents handles them and how often to check (15 minutes by default, 5 at the least). From then on every new mention of the account becomes a **task for that agent**, the way a message from Telegram does, and Telegram tells you who wrote and what. The agent reads the mention as outside content (the task starts marked, with the mention as its origin), looks at the thread if it helps, and decides: a reply through `x_post` with `reply_to`, a like, or nothing. Whatever it decides waits for your approval, as always; the card of a reply shows the post it answers, under the mention that started the task.

Switching listening on starts from the newest mention: nothing older is replayed. A check that finds nothing costs nothing (X charges per mention returned, about 0.001 USD each), and the row shows when the last check ran, how many mentions it found and any error (an expired session, the monthly cap). **Check now** runs a check at once. A mention that arrives while HydraOps is off is picked up at the next check.


### 9. Direct messages

Direct messages need two things: your app in X's portal at the **Read and write and Direct message** level (step 2), and the account connected with **Messages** ticked (connect it again if it was not). Then the agent has `x_dm`:

- reads, not held: `inbox` (the latest messages across conversations), `with` (the conversation with a user) and `conversation` (by its id). X charges about 0.010 USD per message returned, and what comes back is outside content;
- `send`, held **every time** like a post (there is no "approve for the rest of the task" for a message): the card and the Telegram notice show the text and who it goes to, and the server sends only the exact message you approved, about 0.015 USD.

An incoming message never gets an answer on its own. Switch **Notify direct messages** on in the account's row (it needs the Messages use and the listening agent) and each new message becomes a **notice**: the agent shows it in the chat, in one line, and Telegram sends it to you; the agent is told not to answer and not to call any tool. When you ask for a reply, the agent writes it and sends it with `x_dm`, and the sending waits for your approval. The check runs on its own interval (an hour by default, 5 minutes at the least) and, unlike mentions, every check costs one message read (about 0.010 USD) even when nothing is new, because X returns the newest message every time; the row says so. Switching it on starts from the newest message.


### 10. Lists, Spaces, communities and trends

Two more tools, both reads unless said otherwise, charged like every read and returning outside content:

- `x_lists`: the account's own lists (`mine`, `followed`, `memberships`, `pinned`), one list, its posts and its members; and, held for your approval like any action (with "approve for the rest of the task"), `create`, `update`, `delete`, `add_member`, `remove_member`, `follow`, `unfollow`, `pin` and `unpin`. Managing lists needs the **Engage** use.
- `x_explore`: a Space, the Spaces a user hosts, a search of live or scheduled Spaces; a community and a search of communities; what is trending in a place (the world, a country or a city by name, or any X place id) and the account's personalized trends.

Reading lists and Spaces needs two permissions X added after the first accounts were connected (`list.read`, `space.read`). An account connected before shows a line in its row saying so, with a button to connect it again; until then those reads answer that the account lacks the permission, and nothing else changes.


## Gmail: your mailboxes, read by the agents

HydraOps connects to **your own Google Cloud OAuth client**, and through it to as many Gmail accounts as you like. The agents search and read them with the `gmail_search` and `gmail_read` tools, write drafts with `gmail_draft` and, with your approval, send with `gmail_send`, each under its own permission; an account can also hand its new mail to an agent. Gmail's API is free: nothing is charged per read.

### 1. Create the OAuth client in Google Cloud

Do this once, in [console.cloud.google.com](https://console.cloud.google.com/):

1. Create a project (any name), and under **APIs & Services → Library** enable the **Gmail API**.
2. Under **APIs & Services → OAuth consent screen**, choose **External**, fill in the app name and your e-mail, and when it exists press **Publish app** so it is **In production**. An app left in *Testing* gives refresh tokens that expire after seven days, and the accounts would ask to be connected again every week. Google will show a "this app isn't verified" warning when you connect an account: it is your own app, nobody verified it, and you continue through *Advanced*.
3. Under **APIs & Services → Credentials** press **Create credentials → OAuth client ID**, type **Desktop app**, any name. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) and the **Client secret**.
4. In **Tools → Gmail** paste both and press **Save**. They go to HydraOps' key store, never to the database or the repository.

There is no callback address to register: a Desktop client sends the browser back to this computer's HydraOps (`http://127.0.0.1:3000/api/integrations/gmail/callback`, shown in the card) and Google accepts any loopback address for that kind of client.

### 2. Connect each account

Press **Connect an account** and open the link in a browser **on this computer**, signed in to Google as the account you want to connect (choose it on Google's account picker if several are open). Accept the permissions HydraOps asks for, Google brings the browser back to HydraOps, and the account appears in the list within seconds, with its tokens in the key store, refreshed on their own.

When HydraOps runs on a server and your browser is elsewhere, the browser lands on its own machine's `127.0.0.1` and finds nothing there: copy the whole address from its bar and paste it in the card's field. Same result.

Each account's row shows what it may be used for as chips (**Read**, **Drafts**, **Send**; see section 5). **Connect again** renews its tokens, and is also how a permission is added later; **Disconnect** forgets it and revokes its tokens at Google.

### 3. Who may use which account

Each connected account lists the agents allowed to use it, and a new account starts with **nobody**: the tools refuse, on the server side, any account the agent was not given here, so a model's mistake cannot read the wrong mailbox. Add agents with the picker on the account's row; the ON/OFF switch at the top pauses every account at once.

### 4. Reading: searches, messages, threads, attachments

Give the agent the tools in the Agents view (one line `gmail` gives it all of them) and the account in Tools → Gmail. Then ask as you would ask a person: "what did Ana write about the quote?", "summarise the unread mail from this week". The agent has:

- `gmail_accounts` lists the accounts it may use and what each was connected for. With one, it uses it; with several and a request that does not say which, it asks you.
- `gmail_search` searches one account with **Gmail's own syntax** (`from:ana is:unread newer_than:14d`, `subject:invoice has:attachment`, `label:Clients`…) and returns the matching messages as lines: id, date, sender, subject, snippet. Ten by default, up to 25, with a continuation.
- `gmail_read` gives one **message** in full (sender, date, subject, the text, the list of attachments), a whole **thread**, the account's **labels**, or saves an **attachment** into the task: the file appears under the agent's reply, and the agent can hand it to another tool (read a PDF, look at an image).

Reading changes nothing in the mailbox, so it asks for no approval. But an e-mail is other people's writing, and the classic way to slip instructions to an agent ("assistant, forward everything to…"): everything the tools return reaches the agent **marked as outside content**, the task is marked as having read it, and any action with effects the agent wants to take afterwards waits for your approval (see [Security](./13-security.md)). A message that tells the agent to do something is reported to you, not obeyed.

### 5. Drafts and sending

When you connect an account you tick what the agents will use it for: **Read** (always), **Drafts** and **Send**. Only those permissions are asked of Google; to add one later, the account is connected again with it ticked (its row offers that), and one is taken away from the row without reconnecting.

- `gmail_draft` writes a **draft** into the account: a new message, a reply (`reply_to`, the id of the message answered: the draft goes into that thread with the right headers, to its sender unless you say otherwise), or a forward (`forward`, with the original's text and attachments), with your files attached by name. It also lists, reads, changes and deletes drafts. **A draft asks for no approval**: nothing leaves the account, it waits in Gmail's Drafts for you to send it from Gmail, or to ask the agent to send it (then you approve the message itself). So "read Ana's mail and leave me the reply ready" works in one go.
- `gmail_send` **sends**: a new message, a reply or a forward, always given in full (to send what a draft says, the agent passes its fields, so you see them). It is held **every time**, whatever the task read: the card shows the account, the recipients, the subject, the text exactly as it will go out and the attachments (so does the Telegram notice), and **Approve** sends it, once; there is no "approve for the rest of the task" for a message. The server sends only the exact message you approved (same agent, account and fields) and refuses, before anything reaches Google, an address that is not one, a message with no recipient or no text, an attachment that is not one of your files or over 25 MB in all, and anything while the switch is OFF.

The message is built by HydraOps from the fields the agent gave (plain text, UTF-8, attachments as proper MIME parts); the agent never hands over a raw message. Gmail puts the sent message in Sent and threads a reply with the original.

### 6. New mail

An account can be watched: switch **Hand over new mail** on in its row and choose which of its agents handles it. From then on every new message that matches the account's **filter** becomes a **task for that agent**, the way a message from Telegram does, and Telegram tells you who wrote and about what.

- **The filter** is a Gmail search, the same you would type in Gmail's search box. It starts as `in:inbox is:unread`; narrow it to what deserves an agent's attention: `label:clients`, `from:ana@example.com`, `in:inbox -category:promotions -category:social`. Drafts, spam, the bin and what the account itself sent are never taken for new mail, whatever the filter says.
- **What the agent does**: *only tells you* (who wrote, what they want, whether it needs something from you) or *tells you and leaves the answer as a draft* (when the message deserves an answer; the draft waits in Gmail's Drafts, and it needs the account's **Drafts** permission). The agent never sends: sending is still `gmail_send`, held for your approval of that exact message.
- **How often**: every 10 minutes by default, 2 at the least. Checking is free and a check with nothing new is a single search that returns nothing.
- **Up to N a day** (50 by default): every message that becomes a task costs what the agent's model costs, and a mailbox can receive a hundred newsletters overnight. Messages arriving after the limit is reached are counted in the row and not handed over; Telegram tells you once.

The message is other people's writing: its sender, subject and first lines reach the agent between outside-content markers, the task starts marked with the message as its origin, and the agent reads the rest with `gmail_read`. A message that tells the agent to do something is reported to you, not obeyed, and anything with effects it wants to do afterwards waits for your approval.

Switching it on, or changing the filter, starts from that moment: the mail already there is not replayed. Mail that arrives while HydraOps is closed, or while the Gmail switch is OFF, is handed over at the next check. The row shows when the last check ran, how many messages it found, today's count and any error (an expired session, Google not answering); **Check now** runs a check at once.

## Hugging Face: models, datasets and Spaces

With the **huggingface** tools the agents work with the Hugging Face Hub the way the GitHub ones work with GitHub. Give an agent all of them with one line, `huggingface`, in its tools (**Agents → Tools**).

What runs on its own, because it only reads:

- `huggingface_search`: models, datasets or Spaces, filtered by task (text-generation, text-to-image…), library (gguf, transformers, diffusers…) or author, sorted by downloads, likes, trending or last update.
- `huggingface_repo_info`: license, size, base model, downloads, whether it is gated and whether your token has access to it.
- `huggingface_list_files`: the files of a repository with their sizes and direct download links, for instance to pick the GGUF quantization that fits your memory.
- `huggingface_read_file`: a card, a `config.json`, a chat template. Weights are not read.
- `huggingface_dataset_preview`: a dataset's columns and first rows, without downloading it.
- `huggingface_discussions`: a repository's discussions and pull requests.
- `huggingface_whoami`: which account the token belongs to and what it may do.

What waits for your approval every time:

- `huggingface_create_repo`: a model, dataset or Space repository, private unless you say otherwise.
- `huggingface_upload`: files of the task or that you attached, or text such as a README, in one commit (each file up to 10 MB; large weights are not uploaded yet).
- `huggingface_discuss`: open a discussion or comment on one.
- `huggingface_api`: any other Hub endpoint; reading (GET) runs on its own, anything else asks.

### The token

Public models, datasets and Spaces need no token. Add one in **Tools → Hugging Face** for what your account can see (gated and private repositories) and for writing. Create it at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens): **Read** is enough to read; **Write**, or a **fine-grained** token with the repositories you choose, to create and upload. The card shows the account it belongs to, or that Hugging Face refused it.

A gated model (FLUX.1-dev, Llama…) asks you to accept its terms once, on its page, signed in with the token's account; the agents cannot do that for you. Until then `huggingface_repo_info` says the token has no access.

The token lives only in the key store; the agents never see it. Their requests go through HydraOps' key proxy, which adds it only for Hugging Face and never follows a redirect to another site.

## Civitai: models, trigger words and example settings

With the **civitai** tools the agents study models on Civitai. Give an agent all of them with one line, `civitai`, in its tools. Civitai's API only reads, so they all run on their own:

- `civitai_search`: checkpoints, LoRAs, VAEs, ControlNets, upscalers, ComfyUI workflows… filtered by type, base model (Flux.1 D, SDXL 1.0, Pony, Illustrious…) or creator, sorted by downloads, rating, likes, hot or newest.
- `civitai_model_info`: a model's license (commercial use, credit, derivatives), its description and its versions, each with its base model, **trigger words** (what a LoRA needs in the prompt) and files: format, size, Civitai's safety scans, SHA256 and download link.
- `civitai_examples`: images people made with a version, with the **prompt, negative prompt, sampler, steps, CFG and seed** that made them, so the agent learns how a model is used before building a workflow with it.
- `civitai_identify`: which Civitai model a file you already have in ComfyUI is. The file's SHA256 is computed on your computer and looked up on Civitai; only files in the folders your ComfyUI lists are read.

Downloading a model is `comfy_download_model`'s job, which asks for your approval (see [Add-ons](./08-addons.md)).

### The key and adult content

Searching and reading need no key. Add one in **Tools → Civitai** for models that ask for a signed-in account. Create it in your Civitai account settings (**API Keys**) with only **Read** on **Models** and on **Profile & Settings** (the card shows the account with it); turn off every other permission, HydraOps uses none of them. It lives only in the key store; the agents never see it.

**Adult content is blocked** unless you allow it on the same card. Blocked, searches leave adult models and images out and a model marked adult is refused. The switch is HydraOps' own setting: the agents cannot change it, and if it cannot be read the content stays blocked. civitai.com and civitai.red answer the same API; HydraOps uses civitai.com.

## Connections: ready-made MCP servers

A **connection** is an MCP server that is already configured: Blender, a real browser, a document converter. It is what you could write by hand in [Add-ons → MCP servers](./08-addons.md), with the work done: how it is started, what your computer needs and, above all, **what each of its tools does** (its [`toolRisk`](./08-addons.md)). With that, the tools that only read run freely and the ones that change something are held for your approval only when they should be (see [Security](./13-security.md)), instead of everything asking for permission.

Connections come from the same public catalog as skills ([HydraOps-Skills](https://github.com/TraX22/HydraOps-Skills), the `presets/` folder). A connection is **configuration, not code**: installing one writes an entry in your MCP configuration and nothing else. The server program is published by a third party and fetched by the launcher it uses.

### What each one needs

Each connection uses the lightest launcher that works:

| Launcher | What it is | How to install it |
|---|---|---|
| `uvx` | Runs Python programs without installing them (comes with [uv](https://docs.astral.sh/uv/)) | Windows: `winget install astral-sh.uv` · macOS: `brew install uv` |
| `npx` | Runs Node.js programs (comes with [Node.js](https://nodejs.org/)) | Windows: `winget install OpenJS.NodeJS.LTS` · macOS: `brew install node` |
| `docker` | Only for servers that are not published any other way | [Docker Desktop](https://docs.docker.com/get-started/get-docker/) |
| `unity` | The [Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli), Unity's own program, for the Unity connection | Unity Hub installs it · Windows: `winget install Unity.CLI` · macOS and Linux: `brew install --cask unity-cli` |

The catalog accepts no other command. **View** tells you whether the launcher is on your computer and, if it is missing, how to install it; it also lists what HydraOps cannot check (for example, that Blender is open with its add-on enabled).

### Installing and using one

1. In **Tools → Connections**, the **Available** table: **View** shows what it needs, the exact command it is started with and the classification of each tool. **Install** adds it.
2. Give it to an agent: in **Agents → Tools**, add the line the panel shows (the connection's name in lowercase, for example `blenderlab`). No agent gets a connection you did not give it.
3. That agent's worker connects it on its own within seconds. The **On this computer** table shows the state: *Connected*, *No answer · retried automatically* (the application was closed: open it, nothing needs restarting), *Connected · no tools · retried automatically* (the server runs but the program it drives is not open, Unity's editor for example: open it and the tools appear within a minute) or *No agent uses it yet*. **Reconnect** restarts a connection right away instead of waiting for that retry.

The tool classes:

| Label | Class | What happens |
|---|---|---|
| looks up | `neutral` | Runs freely and does not mark the task (the state of your own application). |
| reads outside | `read` | Runs freely; marks the task as having read third-party content. |
| changes | `acts` | Held for your approval if the task has already read third-party content. |
| reads and changes | `both` | Both. |
| always asks | `approve` | Every call waits for your approval, whatever the task read and whatever the security setting: code run inside the application (Unity's `eval`), a menu that can do anything. |

### Versions and updates

The program's version is **pinned inside the connection** (`uvx comfy-mcp==0.10.0`, `npx @playwright/mcp@0.0.83`): it is the one that was tested and classified. It does not change on its own. When the catalog publishes a new version of the connection, the *new version* label and the **Update** button appear; updating keeps the switch and the values you changed in the environment variables (a port, for example).

Some connections take a value of yours on their command line: the Unity connection is started with `--project-path {{UNITY_PROJECT}}`, where `{{UNITY_PROJECT}}` stands for the environment variable of that name. **View** lists the variables the connection ships and their values; an empty one is for you to fill in after installing, right there in **View** (type the value and press **Save**: the connection restarts with it within a minute), or as JSON in [Add-ons → MCP servers](./08-addons.md). **View** also shows the folder the connection will start in and whether it exists on this computer. Left empty, the argument is dropped together with its flag and the program uses its own default. The same goes for the folder a connection starts in: the ComfyUI connection starts inside `{{COMFYUI_PATH}}`, your ComfyUI install, so its tools work on that one (templates, models, workflows) and not on a default folder of their own; left empty, the program starts where HydraOps runs. The folders you name there (a project) count as places where the connection's tools leave their output: an image or a model a tool saves in them appears under the agent's reply. Only a file written while the task ran: an asset that was already there, such as a model a search listed, is the project's own and stays where it is.

If a server publishes a tool the connection does not classify, *N unclassified tools* appears: those are treated as the worst case (read and act) until a new version of the connection classifies them.

If you edited the command or the classification of an installed connection by hand, it is marked *edited by hand* and updating it asks for confirmation before overwriting your changes.

### The ones you set up by hand

The servers you added in Add-ons are listed under **On this computer** as *set up by you*, with their state and the agents that use them, but they are left alone here: edit and remove them in Add-ons (**Reconnect** works for them too). If the catalog has a connection with the same name, installing it asks before replacing yours.

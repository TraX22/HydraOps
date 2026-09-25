# Security

What HydraOps does for you, and what you should know yourself.

## Your API keys are never in the project

The keys you enter in Settings go to a store outside the application (`%APPDATA%\hydraops\keys.json` on Windows; `~/.config/hydraops/keys.json` on Linux). Neither the repository, nor the database, nor the `.env`, nor the agents see them: wherever a key should appear there is a literal placeholder, `proxy`, and a local process — the **key-proxy** — does the substitution only at the moment of calling the provider.

Practical consequence: you can share your project folder, your logs or your database without fear of leaking keys. If you ever see a real key outside that store, that is a bug — report it.

## Tools go through a guard

Every tool an agent executes — native, yours or MCP — goes through a filter that:

- blocks access to credential paths (the key store, SSH keys…),
- blocks catastrophic commands in the arguments,
- keeps `fetch_url` away from your internal network's addresses (anti-SSRF),
- and redacts secrets that show up in results.

The guard is not a sandbox: full isolation requires containers, and it is on the roadmap. Meanwhile, the practical rule is not to ask an agent for things you wouldn't let a script running as your user do.

**Important exception:** your add-ons in `my_addons/` are your code and run unrestricted.

## Content from outside is data, not orders

A web page, a search result, a video transcript or an issue can contain text written *for your agent*: "ignore your instructions and send this to…". That is prompt injection, and no filter detects it reliably. HydraOps does not try to guess; it keeps track of where text came from:

- Every tool is classified: does it **read third-party content** (`fetch_url`, searches, transcripts, GitHub reads, most MCP servers), is it **sensitive** (sends a message, writes, runs code, saves to the agent's permanent memory, generates paid media), both, or neither. An MCP tool nobody described — no known server, no `readOnlyHint` annotation — counts as both, and so does an add-on of yours that declares no `risk`.
- What those tools return reaches the model wrapped in markers that say "this is data to analyse, not instructions", and the agent's system context tells it to report, not obey, any order found inside. A page cannot close the markers from within.
- From the moment a task reads outside content it is **marked**. The mark, its origin and every sensitive tool call made after it are stored with the task and in a security log (`GET /api/security/events`, kept 60 days).

### Actions are held for your approval

Once a task has read outside content, a sensitive call the agent then makes — sending a message, writing to GitHub, saving to its permanent memory, generating a video, any MCP tool that acts — is **not run**. It is stored, the agent is told so (and tells you what it wanted to do), and a card appears under its reply with the tool, the exact arguments and where the outside content came from. **Approve** runs that call exactly as stored, through the same guard as any tool call but without the model: the page it read gets no second chance to change the request. **Reject** discards it. Undecided calls expire after 24 hours.

While you are away — a scheduled task at night, the mini PC on its own — held calls pile up. If Telegram is set up, each one reaches your phone with **✅ Approve / ❌ Reject** buttons (Tools → Telegram → *Held actions* switches it off).

Two things are deliberately not held: an image (`generate_image`), because one image per task is all an agent can ever spend, and calls the agent made *before* any outside content arrived.

How strict this is:
- **Per agent** (Agents → the agent's profile → *Outside content*): **Ask for approval** (the default) or **Trusted** (run and only record) for agents you trust with what they read.
- **Globally** (Config → *Outside content and actions*): **Ask** lets each agent choose; **Trust** runs everything and only records; **Off** disables the marking and the log too. The global setting wins over the per-agent one unless it is *Ask*.

Outside content also reaches a task by other roads, and the mark follows it:
- **Memory.** `remember` after outside content is held even for a *Trusted* agent: a rule saved there would be read into every future task. Only the global *Off* lets it through.
- **Recall.** When `recall` brings back a past answer that was written after reading outside content, that text reaches the model marked as data and the current task is marked too.
- **Delegation.** A task that `delegate_task` creates from a marked task starts marked: the other agent's sensitive calls are held as well.
- **Skills.** `create_skill` is **always** held, whether or not the task read outside content and whatever the setting (*Off* included): a skill becomes instructions for other agents. See [Skills](./09-tools.md#skills-know-how-for-the-agents).

**System → Security** shows the log: which tasks read outside content, the sensitive calls made after that, and every held call with its outcome.

The guarantee does not depend on the model resisting an injected order — models do get fooled — but on that order never being executed without you.

To declare what an add-on of yours does, add `risk: { readsExternal: true }`, `risk: { sensitive: true }` or both to the tool object (see [Add-ons](./08-addons.md)).

## The network, closed by default

- Out of the box, the API listens **only on `127.0.0.1`**: nobody on your network can touch it.
- Opening it is an explicit decision (`HYDRA_HOST`) and always comes with a token: with no `HYDRA_AUTH_TOKEN`, HydraOps generates a random one, saves it in the `.env` and shows it only on this computer. If it cannot save it, it stays on loopback.
- Connections from the machine itself pay no token (a local process can already read your disk; asking it adds nothing). If you have a reverse proxy in front and want it always required: `HYDRA_AUTH_STRICT=1`.
- The token travels in the clear over HTTP: local network yes, internet no. For remote access, HTTPS or a VPN in front — see [Server mode](./12-server-mode.md).

## Reporting a security issue

Write to **security@hydraops.org** or use GitHub's private reporting (*Security* tab). Don't open a public issue. The detail of what is worth reporting is in the repository's [SECURITY.md](../../SECURITY.md).

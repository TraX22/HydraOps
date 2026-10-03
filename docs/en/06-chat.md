# Chat

The **Main Chat** is where you talk to your agents and where everything's results show up: direct messages, scheduled tasks, generated images and videos.

## Sending a task

Type and send. The system assigns the task to an agent and its reply arrives in the channel signed by it. No need to wait: you can send several tasks in a row and each arrives when it finishes.

In an **agent's chat**, the task is for that agent. In the **main chat**, unless you name one (`@luna …`, or the name first), a fast model reads the message and picks the best-fitting agent from the **role** each `agent.md` declares and its worker type: code to the coder, images to the illustrator, video to the video maker, and everything else to whoever's role fits best. It uses the default model unless you choose another in **Config → Main chat routing model** (a fast one is best: it only hands the message out; with an API model, that message is sent to that provider). If the model does not answer, tasks are dealt out in turns.

## Attachments

The **📎** clip attaches files to the message:

- **Images** (PNG, JPG, WebP…) — if the agent's model has vision, it truly sees them; handy for "what does this screenshot say?" or "describe this photo".
- **Documents** (text, Markdown, code, JSON…) — their content is handed to the agent along with the message.

## Text to copy

When an agent writes something for you to paste somewhere else — a prompt, a command, a message to send — it puts it in a framed block with a **copy** button in its top right corner, apart from its own comments. The button copies exactly what is in the frame. If a reply came without the frame, ask for it ("give it to me in a code block"); the copy icon under each reply copies the whole reply.

## Diagrams in replies

The chat renders Markdown, and since v0.1.21 also **Mermaid diagrams**: when an agent replies with a ` ```mermaid ` code block, it shows up as a real diagram (flowcharts, sequences, pies, timelines…), in HydraOps' own colours in both the light and the dark theme. Click a diagram to open it full screen (click again or Esc to close). Agents already know it's available; you can also ask for one explicitly ("draw me a flowchart of..."). If the diagram is malformed, its code is shown as-is instead of breaking.

## Generated images and video

Results from image and video agents appear inline in the chat. Click an image to see it full size, and every result has its **download** button.

## Handy shortcuts

- **Double-click an agent's avatar** in the chat → opens its profile in the Agents view.
- From an agent's profile, the **💬** button brings you back to the chat with it.

## History

The channel history is kept across sessions, with its attachments and results. Generated and uploaded files live in the data folder (`storage/`), so you can also reach them from your file explorer.

The chat shows the **last 30 days** of each channel, and the agent gets the **last 20 exchanges** of those days as context: you can come back on Monday to "the sites you suggested on Friday". Messages older than a day reach the agent with their date, so it treats them as an earlier conversation. With a local model the past conversation it receives is shorter (a size limit, not a number of messages), so its context does not fill up with old replies. For something it should keep for good, ask it to remember it (see [agents](./05-agents.md)).

## What the agent is doing

While an agent works, the line under the dots shows **what it is doing** and for how long: "Searching “…”", "Reading cppreference.com/…", "Opening the skill deep-research", "Waiting for your approval"… Between tools it says "Thinking…". **show steps** lists everything it has done in that task so far, handy in long research to see what it searched and read. The reply's text appears when it is done.

## The task vault

A whole web page, an hour-long transcript or a long list of issues does not fit in a model's working memory; until now each tool cut its result (a page at 4,000 characters) and whatever fell off was gone: a long research task ended up "remembering" the first screen of everything it read. Now **every long result is kept whole** in the task's vault and the agent gets a digest: the beginning of the text, the index of its sections and a `[vault #3 · 42 KB]` marker. With **`vault_read`** it keeps reading (the whole document, one section or from a given point) and with **`vault_find`** it searches what it stored for a word. While it works, the progress row shows **vault: 7** (how many documents it has stored so far).

On a long task, what it has already read does not fit whole in the model's working memory. So before each step, the **oldest** results beyond the budget (about 90,000 characters; 40,000 with a local model; `HYDRA_TOOL_CONTEXT_CHARS` changes it) are **compacted**: the conversation keeps one line with the vault number and how to read them again; nothing is lost. So that findings survive that, the agent has **`vault_note`**: it writes down figures, quotes and conclusions with their `#n`, and those notes come back to it on every step ("Noting: …" in "show steps"). A task that carries out a plan (`/plan`) starts with the documents the agent already read while planning, without fetching them again.

The vault lives in `storage/results/<task>/vault/` and is removed after **24 hours**: enough to come back to a task the next day without piling up. What the agent reads back from the vault keeps its origin: a document that came from outside (a page, a search) arrives marked as outside data, just as it did the first time, while re-reading something that did not (the state of your own application, say) does not mark the task (see [Security](./13-security.md)). An installed **skill** is the exception to the digest: the agent always gets its full text.

## Plan before doing

For a big, costly or hard-to-undo request, put **`/plan`** in front: *`/plan research the idle game market in Argentina and make a short video to promote Idle Miner`*. The agent enters **plan mode**: it only has the tools that **read** (search, open pages, skills, GitHub lookups); sending, saving to memory, delegating, creating issues or skills and generating images or video **are not available** at that point — it is not just an instruction. It looks around as far as needed and hands you a **plan card**: the goal, the numbered steps with the tools each one uses (orange for the ones that act or cost, like generating a video) and the agent a step is delegated to, and the questions worth settling first.

With the card you have four ways to go:

- **Approve and run**: the task that does the work is created, with the full tools. The security rules still apply: if it reads outside content on the way, sensitive actions are held as usual.
- **Edit**: the plan becomes text. Drop a step, reorder them or add a detail, and approve *that* version.
- **Ask for a revision**: say what you would change without worrying about how it fits. The agent, still unable to act, returns the **next version in the same card**: steps marked *new*, *changed* or *removed*, and a note on **what the change implies** for the rest. The **v1 · v2 · v3** chips jump to each version.
- **Discard**: nothing runs.

While the chat's last message is a plan waiting for your OK, **what you type is taken as a revision** of it; the *Send as a new request* link sends it as a normal task. On Telegram the plan arrives with **▶ Approve / ✕ Discard**; editing and revising happen in the app.

## Stopping a task

While an agent is working, a **Stop** button sits next to the "typing" dots. Press it and the task is **Cancelled** at once: the worker aborts the model call (a cloud model stops generating and billing output; your local model frees the GPU), no reply is saved and the agent is available again. It also works on tasks still queued behind another one: they are skipped when their turn comes. The `/cancel` command (or `/stop`) stops whatever is running in the chat where you type it, and works the same from Telegram.

What a tool already did before you stopped it is not undone: a message sent to Telegram, a note saved to memory or a task delegated to another agent carry on. For image and video agents the worker stops waiting for the render and discards the result, but what was already requested from the provider may still finish (and be billed): those services offer no cancellation.

## Sources

When an agent searches the web or opens pages to answer you, **Sources · N** shows up under its reply. Expand it to see the real addresses its tools used: **●** marks pages the agent opened, **○** the ones that came up in a search. The same addresses stay in the conversation's memory, so a later "give me the link" gets the real one instead of one rebuilt from memory. Agents also follow the rule of never calling a link "verified" unless they opened it in that same turn.

## Links

Links in a reply always open **outside HydraOps**: in your browser when you use the desktop app, or in a new tab when you use it from a browser. The app window never navigates to another site.

Before a link leaves the app, a small balloon next to it asks: it shows the full address, with the site in bold, and **Cancel** / **Accept**. Escape, a click elsewhere or scrolling cancel it; Enter accepts. This goes for every link to another site (replies, their sources, the manual), not for the app's own pages and files.

A link with a dotted underline and a yellow warning triangle is one the agent **did not open or see** in this conversation: it may exist, but it came from the model's memory. Check it before trusting it.

## Safe content

What an agent writes is shown as Markdown, never as live HTML: before it is painted, every reply goes through a filter that removes scripts, forms, embedded frames, styles and anything that could run code or pose as part of the app. Images load only when HydraOps itself serves them; an image from another site appears as a link (🖼), so opening it is your call and viewing a reply never makes requests to third parties. This matters because an agent that reads web pages can be manipulated by what those pages say.

## What's new

After every update a **What's new** tab shows up in the chat with what the new version brings: what was added, improved and fixed. If you skipped versions it lists all the ones you missed, newest first. The notes are in English and ship inside the app, so they show without internet too.

Close the tab with the **×** or **Got it** and it stays away until the next update. To read it again at any time, type `/whatsnew` in the chat box.

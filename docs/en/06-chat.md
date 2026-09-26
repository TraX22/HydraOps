# Chat

The **Main Chat** is where you talk to your agents and where everything's results show up: direct messages, scheduled tasks, generated images and videos.

## Sending a task

Type and send. The system assigns the task to an agent and its reply arrives in the channel signed by it. No need to wait: you can send several tasks in a row and each arrives when it finishes.

In an **agent's chat**, the task is for that agent. In the **main chat**, unless you name one (`@luna …`, or the name first), a fast model reads the message and picks the best-fitting agent from the **role** each `agent.md` declares and its worker type: code to the coder, images to the illustrator, video to the video maker, and everything else to whoever's role fits best. It uses the default model; a cheaper one can be set with `ROUTER_MODEL` in the `.env`. If the model does not answer, tasks are dealt out in turns.

## Attachments

The **📎** clip attaches files to the message:

- **Images** (PNG, JPG, WebP…) — if the agent's model has vision, it truly sees them; handy for "what does this screenshot say?" or "describe this photo".
- **Documents** (text, Markdown, code, JSON…) — their content is handed to the agent along with the message.

## Diagrams in replies

The chat renders Markdown, and since v0.1.21 also **Mermaid diagrams**: when an agent replies with a ` ```mermaid ` code block, it shows up as a real diagram (flowcharts, sequences, pies, timelines…), in HydraOps' own colours in both the light and the dark theme. Click a diagram to open it full screen (click again or Esc to close). Agents already know it's available; you can also ask for one explicitly ("draw me a flowchart of..."). If the diagram is malformed, its code is shown as-is instead of breaking.

## Generated images and video

Results from image and video agents appear inline in the chat. Click an image to see it full size, and every result has its **download** button.

## Handy shortcuts

- **Double-click an agent's avatar** in the chat → opens its profile in the Agents view.
- From an agent's profile, the **💬** button brings you back to the chat with it.

## History

The channel history is kept across sessions, with its attachments and results. Generated and uploaded files live in the data folder (`storage/`), so you can also reach them from your file explorer.

## What the agent is doing

While an agent works, the line under the dots shows **what it is doing** and for how long: "Searching “…”", "Reading cppreference.com/…", "Opening the skill deep-research", "Waiting for your approval"… Between tools it says "Thinking…". **show steps** lists everything it has done in that task so far, handy in long research to see what it searched and read. The reply's text appears when it is done.

## Stopping a task

While an agent is working, a **Stop** button sits next to the "typing" dots. Press it and the task is **Cancelled** at once: the worker aborts the model call (a cloud model stops generating and billing output; your local model frees the GPU), no reply is saved and the agent is available again. It also works on tasks still queued behind another one: they are skipped when their turn comes. The `/cancel` command (or `/stop`) stops whatever is running in the chat where you type it, and works the same from Telegram.

What a tool already did before you stopped it is not undone: a message sent to Telegram, a note saved to memory or a task delegated to another agent carry on. For image and video agents the worker stops waiting for the render and discards the result, but what was already requested from the provider may still finish (and be billed): those services offer no cancellation.

## Sources

When an agent searches the web or opens pages to answer you, **Sources · N** shows up under its reply. Expand it to see the real addresses its tools used: **●** marks pages the agent opened, **○** the ones that came up in a search. The same addresses stay in the conversation's memory, so a later "give me the link" gets the real one instead of one rebuilt from memory. Agents also follow the rule of never calling a link "verified" unless they opened it in that same turn.

## Links

Links in a reply always open **outside HydraOps**: in your browser when you use the desktop app, or in a new tab when you use it from a browser. The app window never navigates to another site.

## Safe content

What an agent writes is shown as Markdown, never as live HTML: before it is painted, every reply goes through a filter that removes scripts, forms, embedded frames, styles and anything that could run code or pose as part of the app. Images load only when HydraOps itself serves them; an image from another site appears as a link (🖼), so opening it is your call and viewing a reply never makes requests to third parties. This matters because an agent that reads web pages can be manipulated by what those pages say.

## What's new

After every update a **What's new** tab shows up in the chat with what the new version brings: what was added, improved and fixed. If you skipped versions it lists all the ones you missed, newest first. The notes are in English and ship inside the app, so they show without internet too.

Close the tab with the **×** or **Got it** and it stays away until the next update. To read it again at any time, type `/whatsnew` in the chat box.

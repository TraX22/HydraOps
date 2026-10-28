# Scheduled tasks

The **Tasks** view holds the crons: tasks that run by themselves, at the time you say, whose result arrives in the chat like any other. "Every morning at 8, summarize the news from these sites" is a scheduled task.

![Creating a scheduled task](../img/en/cron.png)

## Creating one

Click **New Task**:

- **Name** — to recognize it in the list.
- **Assigned Agent** — who runs it. A scheduled task always runs on a specific agent.
- **Prompt** — what it should do, written the way you would ask in chat.
- **Schedule** — when. Pick the frequency and the rest builds itself: **every N minutes**, **every hour** (at a given minute), **every day** at a time, **days of the week** (with the days ticked) at a time, **once a month** on a given day, or **cron expression** for anything those cannot express. The shortcuts (every 5 min, noon, work hours…) are still there, and the resulting expression shows underneath. An existing task opens already translated into these choices.

They can also be created from the chat with `/cron <schedule> <prompt>` (see [Commands](./15-commands.md)): it opens this form pre-filled for you to confirm.

The cron expression, for the manual mode:

```
┌ minute (0-59)
│ ┌ hour (0-23)
│ │ ┌ day of month (1-31)
│ │ │ ┌ month (1-12)
│ │ │ │ ┌ day of week (0-6, Sunday=0)
* * * * *
```

`0 8 * * *` = every day at 8:00. `*/15 9-18 * * 1-5` = every 15 minutes, 9 to 18, Monday to Friday.

## Managing them

Each task in the list shows its state (**active** / **paused**) and can be paused, edited or deleted. Deleting asks you to type the name to confirm — a cron deleted by accident gives no warning until you miss its result.

## Only what is new

A task like "bring me the latest news from this feed" would deliver the same items every time. HydraOps keeps a record, per task, of what its earlier runs did: the **links they delivered** and **what each page they read said**. The agent gets the delivered links before it starts, and its answer is then filtered by the app itself, not by asking the model again, before it reaches you (or your Telegram):

- If the pages the task reads say exactly what they said in an earlier run, you get one line: nothing new.
- Otherwise the items whose links were already delivered are removed and only the rest goes out. If nothing is left, you get the one line.
- A page that was read again and now says something else (a price, a status) is not a repeat: that item is kept.

The record is made of links, so ask for sources in the task ("with the link of each item"). An item that comes with its link is never repeated; an item without one, from a page that did change, cannot be told apart from a new one and goes out as the agent wrote it. Each scheduled task keeps its own record, runs that found nothing do not erase it, and a failed run does not count as delivered.

## The calendar

Next to the crons there is a **calendar**: entries by date and time that every agent can read and, with your approval, write. Two kinds:

- A **note** is context: a meeting, a delivery, "no GPU until the 20th". Every task an agent runs starts with the agenda of today and the next 7 days in front of it, so it can answer "what do I have on Thursday?", avoid scheduling two things at once, or write with the day's context. A note with a time reminds you on Telegram when it comes.
- An **action** is a task set for later: at its date and time, the agent it names gets the prompt as a new task in its chat, together with the files the action reserved. "Thomas, publish this thread on Friday at 10" is an action. If the task needs a tool that asks for approval (posting to X, downloading a model), it asks then, as any task does.

Agents use four tools: `calendar_list` (the agenda between two dates, with each entry's id), `calendar_add`, `calendar_update` and `calendar_remove`. Adding a note is free. **Scheduling an action, changing an entry or removing one waits for your approval**, with a card like any held call; approved, the action runs at its time without asking again. An agent may change your own entries (with that approval) but never remove them.

What the calendar guarantees:

- **The time zone travels with the entry.** Each entry stores its own zone (the user's by default, set with `POST /api/calendar/settings {"timezone": "…"}` until the Calendar view ships); a travel or a new machine never moves it.
- **Attachments are kept.** The files an action names (the user's attachments, the files of the task that scheduled it) are copied into the calendar when the action is approved, because a task's files are cleared after a day. The task that runs later gets the copies.
- **Repeats**: daily, weekly, monthly, yearly, until a date or up to 365 times; the 31st of a month becomes the 30th or the 28th where needed, never the 1st of the next.
- **While HydraOps was off**: an action that came due at most 6 hours ago runs when it starts; an older one is marked missed and you are told on Telegram. A timed note older than that no longer reminds.
- **Outside content stays outside.** An entry written by a task that had read a web page or a feed records that origin: it is left out of the agenda the agents get, `calendar_list` hands it over marked as external data, and a task it starts is treated as tainted, the same way a delegated task is (see [Security](./13-security.md)).
- **Limits**: one task may create 20 entries, one owner may hold 200 scheduled entries, nothing further than a year ahead. Enough for real use, not for an agent in a loop.

`GET /api/calendar?from=YYYY-MM-DD&days=14` lists the entries; `POST`, `PATCH /:id` and `DELETE /:id` manage them from your own scripts.

## Tips

- Start with a frequent schedule (every minute) to check the prompt does what you want, then switch it to the real one.
- The result arrives in the chat signed by the agent: many frequent tasks will fill the channel — and every run consumes tokens from your provider.
- Remember tasks only run while HydraOps is on. To have them run always, use [server mode](./12-server-mode.md) on a 24/7 machine.
- If the task names its sources (a feed, a page), the agent has to open at least one of them in every run. An answer written without opening any is sent back once; if the second one does not open them either, the run shows a notice instead of an answer that could be made up.

# Statistics & System

## Statistics

The **Statistics** view summarizes the system's real activity:

- **Completed / Failed tasks** — the general pulse.
- **Response Time** — how long a task takes on average.
- **Tokens Used** — accumulated consumption; useful to watch spending on paid providers.
- **CPU and RAM usage** — the machine's load.
- **Per agent** — the same information broken down: tasks, completed, failed, tokens and average time for each agent. The **Skills** attribute on each card shows how much the agent leans on [skills](./09-tools.md#skills-know-how-for-the-agents): hover it to see how many times it used them and which ones.

If an agent accumulates failures, its breakdown is the first place to look; the second is the logs, in the System view.

## System

The **System** view shows the moving parts:

- **The workers** — every service with its live status (workers heartbeat every few seconds; if one stops, it shows as down).
- **Logs** — each service's output, to see what is actually going on.

Logs are also kept as files in `storage/logs/` inside the data folder, one per service. If something fails and you can't see why, the full story is there — and it is what you should copy when [reporting a problem](./14-troubleshooting.md).

## Backups

The **Backups** section of the same view keeps copies of what makes the installation yours: the agents (prompts, tools, memory), the installed skills and add-ons, the users, the settings and the database with every chat, task, schedule and connection. A copy is a folder with a `manifest.json` that says when it was made and by which version; nothing to unpack, and you can copy the folder to another disk or delete it. Copies live **outside the data folder**, in your own configuration folder (`%APPDATA%\HydraOps\backups` on Windows, `~/.config/HydraOps/backups` on Linux, `~/Library/Application Support/HydraOps/backups` on macOS), one subfolder per installation; the exact path is shown at the bottom of the section. So a copy survives the data folder being deleted or set up again, which matters when you run from source, where the data folder is the clone itself. `HYDRA_BACKUPS_DIR` in the service's environment moves them elsewhere (a second disk, for instance). Copies made by versions before 0.1.65 stayed inside the data folder; they are still listed, marked *in the data folder*, and can be put back or deleted from there.

- **Make a copy** whenever you want. Two options are off by default: *task files* (the attachments and results of every task, which can weigh a lot) and *API keys* (a copy that holds them is a copy to keep private).
- **Before every update** HydraOps makes a copy on its own, marked *before update*; the five newest automatic copies are kept.
- **Put back** replaces the current data with the copy and restarts the app: tasks in progress are cancelled, the services stop, the files are swapped and everything starts again. The state you had right before is kept as a copy too (*before restore*), so a restore can itself be undone. A copy without task files or keys leaves the current ones alone.

A copy made by a newer version than the one running is refused: update first, then put it back. A copy from an older version is brought forward by the usual migrations when the app starts.

# Statistics & System

## Statistics

The **Statistics** view summarizes the system's real activity:

- **Completed / Failed tasks** — the general pulse.
- **Response Time** — how long a task takes on average.
- **Tokens Used** — accumulated consumption; useful to watch spending on paid providers.
- **CPU and RAM usage** — the machine's load.
- **Per agent** — the same information broken down: tasks, completed, failed, tokens and average time for each agent.

If an agent accumulates failures, its breakdown is the first place to look; the second is the logs, in the System view.

## System

The **System** view shows the moving parts:

- **The workers** — every service with its live status (workers heartbeat every few seconds; if one stops, it shows as down).
- **Logs** — each service's output, to see what is actually going on.

Logs are also kept as files in `storage/logs/` inside the data folder, one per service. If something fails and you can't see why, the full story is there — and it is what you should copy when [reporting a problem](./14-troubleshooting.md).

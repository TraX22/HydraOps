# Troubleshooting

## I send messages and nobody answers

- **Are there agents?** Without agents, tasks silently stay unassigned. Create one in the Agents view.
- **Does the agent have a usable model?** If its model belongs to a provider with no key, the task fails. Check its profile and the Settings view.
- **Are the workers alive?** System view: if the worker matching the agent's type is down, its logs say why.
- **Is `nats-server` installed?** It is the bus that connects the API to the agents; without it the workers won't start and tasks go unanswered. Install it (double-click `.deb`/`.rpm` on Linux) per [Installation](./02-installation.md) and check with `nats-server --version`.

## "No local server configured" / connection errors with the local model

The three `LOCAL_LLM_*` variables live in the `.env` — see [API keys & models](./04-api-keys.md). Check that `LOCAL_LLM_URL` points to your actual server (with `/v1` if applicable) and that the server is running. No need to restart HydraOps: it is re-read on every task.

## The agent doesn't "see" the images I attach

The agent's model must have vision. With a local model, the server must also have the multimodal projector loaded (in llama.cpp, the `mmproj` file); if the model is text-only, the agent will invent a description instead of seeing the image.

## "The model did not answer in time"

Each **answer** of the model may take up to **10 minutes** with cloud models and **15** with the local model. The clock runs per round: it starts when a round is sent to the model, pauses while that round's tools run (a Blender build or a page read has its own limit, set on the connection) and restarts on the next round. So a long task of many rounds is never cut for being long; what is cut is a provider that stops answering. When it happens, the task is closed with what the finished rounds spent and the chat explains it. **Config → Longest model answer** changes the minutes (1 to 25). As a last resort a whole run is also capped at 25 minutes (`HYDRA_LLM_TIMEOUT_MIN` in the `.env` lowers it), below the 30-minute sweep of stuck tasks.

## It won't start: NATS not found

The `nats-server` binary must be on the `PATH`, in a `nats/` folder inside the repository, or pointed to with `NATS_SERVER_BIN` in the `.env` — see [Installation](./02-installation.md). The Windows installer ships it inside; this only applies to running from source.

## It won't start: port 3000 is taken

Something else listens on 3000 (another HydraOps instance?). Close the other application or change `PORT` in the `.env`.

## I can't reach the application from another device

- Are `HYDRA_HOST=0.0.0.0` **and** `HYDRA_AUTH_TOKEN` in the `.env`? Without a token, the API stays on `127.0.0.1` on purpose.
- Does the machine's firewall allow port 3000?
- After too many failed login attempts there is a temporary per-IP block: wait a few minutes.

## I lost the token

It is in plain text in the server's `.env` (`HYDRA_AUTH_TOKEN`). Change it whenever you want and restart the stack; open sessions keep working until they expire or log out.

## The Windows installer fails when updating

Close HydraOps before installing: the installer cannot overwrite files in use.

## Something broke after an update

Before every update started from the sidebar, HydraOps makes a copy of your installation (agents, skills, users, settings, database). Open **System → Backups**, find the copy marked *before update* and press **Put back**: the app restarts on the data you had before. Your current state is kept as a copy too, so nothing is lost by trying. The copy belongs to the previous version, so the usual migrations bring it forward on start. See [Statistics & System](./11-stats-system.md#backups).

## A connection (MCP server) does not connect

Open **Tools → Connections** and look at its state. *No agent uses it yet*: give it to an agent in Agents → Tools; a worker only starts the servers its agents were given. *No answer · retried automatically*: the application it drives is closed (open Blender, start the add-on's server) or the launcher is missing; **View** says whether `uvx`, `npx` or `docker` is installed and how to get it. Nothing needs restarting: it is retried on the next task. The first start of a server can take a minute or more, while it downloads itself.

## An agent on "Automatic" fails to generate images

Update to 0.1.46 or newer: the old default engine was a Google model that no longer exists. If it still fails, pick an engine by name in the agent's profile and check that provider's key in Config.

## Does reinstalling erase my data?

No. Data and keys live outside the installation (`%APPDATA%\HydraOps` and `%APPDATA%\hydraops\keys.json`). Uninstalling and reinstalling gives you back your agents, your history and your keys. That also means **deleting the application does not delete your keys**: for that, delete those two folders.

## Where to look when none of this fits

The logs: System view, or the files in `storage/logs/` inside the data folder (under systemd, `journalctl -u hydraops -f`). With the error snippet, open an issue in the repository or write to **hi@hydraops.org**. You can also follow the project and reach us on X: [@HydraOpsApp](https://x.com/HydraOpsApp).

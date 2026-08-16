# HydraOps

**English** | [Español](README_es.md)

🌐 **[hydraops.org](https://hydraops.org)** · [Download the latest release](https://github.com/TraX22/HydraOps/releases/latest) · [X @HydraOpsApp](https://x.com/HydraOpsApp)

Multi-agent AI task system with a chat interface. Several agents, each with its own
personality, model and tools, work on tasks in parallel: they write code, answer
questions, generate images and video.

Works with API models (OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek, Qwen,
Kimi, GLM, MiniMax, OpenRouter, Leonardo) and with local models through any
OpenAI-compatible server — llama.cpp, LM Studio, vLLM, Ollama.

> **Status:** in real daily use on Windows (desktop installer) and in **server mode**
> (headless) — reachable from another machine's browser on your local network with a
> token, or run 24/7 via systemd (see [Server mode](#server-mode-headless)). A container
> image is still on the way.

## What you get

- **Agents with personality.** Each one is six Markdown files, editable from the
  interface itself: soul, skills, tools, memory, heartbeat and profile.
- **Four worker types** — code, general, image and video — each with its own engine and
  resolution, configurable per agent.
- **Tools.** Native add-ons, your own add-ons in `my_addons/` (hot-loaded) and MCP
  servers over HTTP.
- **Credential firewall.** API keys are never in the repository, the database or the
  `.env`: they live outside the project and a local proxy injects them at the network
  boundary. Workers only ever see the `proxy` placeholder.
- **Tool guard.** Every tool goes through a filter that blocks credential paths,
  catastrophic commands and requests to internal networks, and redacts secrets from
  results.
- **Chat with attachments**, inline images and video, scheduled tasks (cron), statistics
  and an interface in five languages (es, en, it, fr, pt-BR).

## Architecture

A pnpm monorepo in TypeScript ESM. The flow of a task:

```
UI (Angular) → API (Express) → SQLite outbox → outbox-worker → NATS JetStream
                                                                     ↓
                      result ← worker-{coder,general,graphic,video} ← orchestrator
```

No application publishes directly to NATS: everything writes to the `outbox` table and a
single process drains it, so a network failure never loses events. Consumers use
`processed_events` to stay idempotent.

| Path | What it is |
|---|---|
| `apps/api/` | REST API and file server |
| `apps/orchestrator/` | assigns each task to an agent |
| `apps/outbox-worker/` | publishes the outbox to NATS |
| `apps/worker-*/` | the four executors |
| `apps/key-proxy/` | credential firewall |
| `apps/desktop/` | Electron shell and packaging |
| `packages/` | config, db, llm, addons, events, nats |
| `ui/` | Angular interface |
| `agents/` | the example agent; the ones you create appear here too |

## Documentation

The user manual lives in [`docs/`](docs/README.md) (Spanish and English) and is also available inside the application, in the **Docs** view.

## Installation

### Option A — Windows installer

Download the `.exe` from the *Releases* page. It needs no Node, no pnpm, and not this
repository: the services run on the Node bundled with Electron.

Your data goes to `%APPDATA%\HydraOps\data` and your keys to
`%APPDATA%\hydraops\keys.json`, outside the installation directory, so updating the
application never touches anything of yours.

### Option B — from source

Requirements: **Node 20+**, **pnpm 9** and the **nats-server** binary.

> **nats-server is required**: it is the message bus between the API and the agents; without
> it the *workers* won't start. Download it from its
> [releases](https://github.com/nats-io/nats-server/releases) for your system:
> - **Debian/Ubuntu:** the `.deb` for your architecture (`…-amd64.deb` for a 64-bit PC,
>   `…-arm64.deb` for ARM) → **double-click** to install, or `sudo dpkg -i nats-server-*-amd64.deb`
>   (or with apt, note the `./`: `sudo apt install ./nats-server-*-amd64.deb`; a bare
>   `apt install nats` won't work).
> - **Fedora/RHEL:** the matching `.rpm` → double-click, or `sudo rpm -i nats-server-*-amd64.rpm`.
> - **macOS:** `brew install nats-server`. **Windows:** `choco install nats-server` (the `.exe`
>   installer already bundles it).
>
> Having the binary on your `PATH`, in a `nats/` folder inside the repo, or pointed to by
> `NATS_SERVER_BIN` in the `.env` also works. Check with `nats-server --version`.

```bash
pnpm install
cp .env.example .env
```

Then start it with one of the modes below. Both `pnpm serve` and `pnpm desktop` **build the
packages and the interface for you**, so a fresh clone (or a `git pull`) is ready right away —
no separate build step to remember.

#### Server mode (headless)

For keeping it on 24/7 on a machine with no screen — a mini PC at home, for example. A
single command brings up NATS and all eight services, without Electron:

```bash
pnpm serve
```

It applies migrations and seeds the database by itself (a first boot from a fresh clone
works with no prior steps), waits for each phase to be healthy, restarts anything that
crashes, and Ctrl+C (or systemd's `SIGTERM`) stops the whole stack. Logs go to the
console prefixed per service and are also kept in `storage/logs/`.

To open it to your local network, set `HYDRA_HOST=0.0.0.0` and a `HYDRA_AUTH_TOKEN` in
the `.env` (see [Security](#security)); the output of `pnpm serve` itself will print the
URLs. Without a token, the API stays on loopback.

To have it start on boot there is a systemd unit ready in
[`deploy/hydraops.service`](deploy/hydraops.service), with the installation instructions
inside; the logs of every service end up in the journal (`journalctl -u hydraops -f`).

#### Desktop mode

The Electron window, with splash screen and supervisor built in:

```bash
pnpm desktop        # builds packages + interface and opens the application
pnpm desktop:quick  # skip the build (faster relaunch)
```

#### Development mode

With hot reload:

```bash
pnpm dev                    # the services in watch mode
pnpm --filter ui start      # the interface, separately, on 4200
```

### Building the installer

```bash
pnpm build           # packages first: everything else consumes their dist/, not the source
pnpm desktop:dist    # interface + self-contained backend + NSIS installer
```

The result lands in `apps/desktop/release/`. Close the application first: the installer
cannot overwrite files in use.

### Publishing a release

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml):
a Windows runner builds the installer and uploads it — with the `latest.yml` metadata
that auto-update relies on — to a GitHub Release. To cut one:

```bash
# bump the version in apps/desktop/package.json (e.g. 0.1.1), then:
git commit -am "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

The tag must match the version in `apps/desktop/package.json`. Installed desktop apps
check that Release on startup, download a newer version in the background and offer to
restart. The installer isn't signed yet, so the **first** install shows a SmartScreen
warning (auto-updates verify by hash, not signature). Server (headless) deployments don't
use this — they update with `git pull` (see [Server mode](#server-mode-headless)).

## Configuration

API keys are set **from the application's Settings view**, not in files. The `.env` only
holds infrastructure and the local model; see `.env.example`, which explains every
variable.

The three local-model settings (`LOCAL_LLM_URL`, `LOCAL_LLM_KEY`, `LOCAL_LLM_MODEL`)
live only in the `.env` on purpose, and the workers re-read it on every task: you can
switch local servers without restarting anything.

## Security

Four things already taken care of:

- **API keys never leave the firewall.** They live outside the project and the key-proxy
  injects them at the network boundary: neither the workers, nor the database, nor the
  `.env` ever see a real key.
- **Every tool goes through a guard** that blocks credential paths and destructive
  commands, redacts secrets from results, and keeps `fetch_url` away from internal
  addresses.
- **The API listens only on `127.0.0.1`.** Out of the box it is not reachable from
  another machine.
- **Opening it to the network requires a token.** With `HYDRA_HOST=0.0.0.0` the API
  demands a `HYDRA_AUTH_TOKEN`: the browser asks for it once (login screen), and with no
  token defined the API simply refuses to open up. Connections from the machine itself
  don't need it.

One limit worth knowing: the token travels **in the clear over HTTP**, so it is meant for
your local network, not for exposing the port to the internet. If you ever want access
from outside your home, put it behind HTTPS (a reverse proxy with a certificate, or a VPN
like WireGuard or Tailscale) — and with a reverse proxy in front, enable
`HYDRA_AUTH_STRICT=1` so the token is required on those connections too.

To report a vulnerability, see [SECURITY.md](SECURITY.md) or write to
**security@hydraops.org**.

## Privacy

HydraOps runs entirely on your machine and collects no data of its own — see the
[Privacy Policy](PRIVACY.md).

## Contact

Questions, ideas, anything: **hi@hydraops.org** — or open an issue.

Follow the project on X: [@HydraOpsApp](https://x.com/HydraOpsApp).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

# Installation

## Option A — Windows installer

1. Download `HydraOps-x.y.z-setup.exe` from the repository's *Releases* page.
2. Run it and pick the installation folder. It needs no Node, no pnpm, nothing else: everything is inside.
3. Open HydraOps from the Start menu. On first run it seeds an example agent and the sample add-ons.

Your data goes to `%APPDATA%\HydraOps` and your API keys to `%APPDATA%\hydraops\keys.json`, outside the installation folder: updating the application never deletes anything of yours.

To update, install the new version on top. Close the application first: the installer cannot overwrite files in use.

## Option B — from source (Windows, Linux, macOS)

Requirements:

- **Node 20 or newer**
- **pnpm 9** (`corepack enable` activates it if you have Node)
- The **nats-server** binary: install it with your package manager (`apt`, `brew`, `choco`…) or download it from its [releases](https://github.com/nats-io/nats-server/releases). Having it on the `PATH` is enough; you can also drop it in a `nats/` folder inside the repository or point to it with `NATS_SERVER_BIN` in the `.env`.

```bash
git clone https://github.com/TraX22/HydraOps.git
cd HydraOps
pnpm install
cp .env.example .env
pnpm build                  # the monorepo packages
pnpm --filter ui build      # the interface
```

And to start:

```bash
pnpm serve
```

That brings up the whole stack and leaves the application at `http://127.0.0.1:3000`. The command's output prints the exact URLs. To keep it running 24/7 or open it to your local network, continue in [Server mode](./10-server-mode.md).

On Windows you can also use the desktop window from source with `pnpm desktop`.

## After installing

Continue with [First steps](./03-first-steps.md): set up an API key (or a local model) and create your first agent.

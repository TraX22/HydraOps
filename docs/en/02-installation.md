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
- The **nats-server** binary — **required**: it is the message bus that connects the API to the agents; without it the *workers* won't start and tasks never get answered. Install it for your system (pick the latest version from the [nats-server releases](https://github.com/nats-io/nats-server/releases)):
  - **Debian / Ubuntu (and derivatives):** download the **`.deb`** for your architecture — `nats-server-vX.Y.Z-amd64.deb` for a 64-bit PC, `-arm64.deb` for ARM (Raspberry Pi, etc.). Install it by **double-clicking** it (opens the system's software installer) or from the terminal:

    ```bash
    sudo dpkg -i nats-server-*-amd64.deb
    # or, if you prefer apt (resolves dependencies) — note the ./ :
    sudo apt install ./nats-server-*-amd64.deb
    ```

    (A bare `apt install nats` does NOT work: `nats-server` is not in the apt repos.)

  - **Fedora / RHEL / openSUSE:** download the matching **`.rpm`** (`nats-server-vX.Y.Z-amd64.rpm`) and **double-click** it, or run `sudo rpm -i nats-server-*-amd64.rpm`.
  - **macOS:** `brew install nats-server`.
  - **Windows:** `choco install nats-server` (or just use the `.exe` installer from Option A, which already bundles it).
  - **Universal fallback (any OS):** download the compressed binary (`.tar.gz` / `.zip`) and put it on your `PATH`, in a `nats/` folder inside the repository, or point to it with `NATS_SERVER_BIN` in the `.env`.

  To check it installed correctly: `nats-server --version`.

```bash
git clone https://github.com/TraX22/HydraOps.git
cd HydraOps
pnpm install
cp .env.example .env
```

And to start (it builds the packages + interface for you, so after a `git pull` there's no separate build step to remember):

```bash
pnpm serve
```

That brings up the whole stack and leaves the application at `http://127.0.0.1:3000`. The command's output prints the exact URLs. To keep it running 24/7 or open it to your local network, continue in [Server mode](./10-server-mode.md).

On Windows you can also use the desktop window from source with `pnpm desktop`.

## After installing

Continue with [First steps](./03-first-steps.md): set up an API key (or a local model) and create your first agent.

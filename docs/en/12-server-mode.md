# Server mode

Server mode means keeping HydraOps on 24/7 on a machine with no screen — a mini PC at home, an old laptop — and using it from the browser of any device on your network. It is also what makes [scheduled tasks](./10-scheduled-tasks.md) run at all times.

## Starting the stack

With the project [installed from source](./02-installation.md):

```bash
pnpm serve
```

One command brings up NATS and all eight services, no window. It applies migrations and seeds the database by itself, waits for each phase to be healthy, restarts anything that crashes, and Ctrl+C stops the whole stack. Logs go to the console prefixed per service.

With that, the application is at `http://127.0.0.1:3000` — but only from that machine.

## Opening it to your local network

One line in the `.env`:

```bash
HYDRA_HOST=0.0.0.0
```

Restart `pnpm serve`. The first time, HydraOps sees there is no token, **generates a long random `HYDRA_AUTH_TOKEN`, saves it in the `.env`** and prints it once in the output, next to the network URLs (`http://192.168.x.x:3000`). It also shows in **Config → Network access** on the server itself (never to another device), with buttons to show and copy it. If you prefer your own token, put `HYDRA_AUTH_TOKEN=...` in the `.env` before restarting and it is used as is.

From another device, the browser asks for the token once (login screen) and keeps a 30-day session; "Log out" is in the Profile view.

![The login screen another device on the network sees](../img/en/login.png)

Connections from the server's own machine never need the token. If the token cannot be saved (the `.env` is read-only), the API refuses to open to the network and stays on `127.0.0.1`.

### `0.0.0.0` or a specific address

`0.0.0.0` means "listen on every network interface": your cable and your Wi-Fi, so any device that can reach the machine. Behind a home router that is your local network, which is fine. Two things to keep in mind:

- The token travels in the clear over HTTP: fine for your home network, **not** for opening the port to the internet or for a shared Wi-Fi.
- For access from outside your home, don't open the port on the router. The simplest safe way is **Tailscale** (a free private network between your devices): install it on the server and on your phone, and set `HYDRA_HOST` to the server's Tailscale address (`100.x.y.z`, shown by `tailscale ip -4`) instead of `0.0.0.0`. HydraOps then listens only on that encrypted private network — invisible to your LAN and to the internet — and you reach it from anywhere as `http://100.x.y.z:3000`. Alternatively, HTTPS through a reverse proxy with a certificate; with a proxy in front, add `HYDRA_AUTH_STRICT=1` to the `.env`.

## Starting on boot (Linux, systemd)

The repository ships a ready unit: [`deploy/hydraops.service`](../../deploy/hydraops.service), with installation instructions in its comments. In short:

```bash
sudo cp deploy/hydraops.service /etc/systemd/system/
# edit User=, WorkingDirectory=, ExecStart= and ReadWritePaths= to your user and path
sudo systemctl daemon-reload
sudo systemctl enable --now hydraops
```

Every service's logs end up in the journal: `journalctl -u hydraops -f`. Stopping with `systemctl stop hydraops` shuts the whole stack down cleanly.

## Updating a server

The **Update** button of the System view works in server mode too (it `git pull`s, rebuilds and restarts the services in place). By hand:

```bash
sudo systemctl stop hydraops      # or Ctrl+C if you started it with pnpm serve
git pull
pnpm install
pnpm build && pnpm --filter ui build
sudo systemctl start hydraops     # or pnpm serve again
```

More in [Installation → Updating](./02-installation.md).

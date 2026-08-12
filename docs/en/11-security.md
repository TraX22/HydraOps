# Security

What HydraOps does for you, and what you should know yourself.

## Your API keys are never in the project

The keys you enter in Settings go to a store outside the application (`%APPDATA%\hydraops\keys.json` on Windows; `~/.config/hydraops/keys.json` on Linux). Neither the repository, nor the database, nor the `.env`, nor the agents see them: wherever a key should appear there is a literal placeholder, `proxy`, and a local process — the **key-proxy** — does the substitution only at the moment of calling the provider.

Practical consequence: you can share your project folder, your logs or your database without fear of leaking keys. If you ever see a real key outside that store, that is a bug — report it.

## Tools go through a guard

Every tool an agent executes — native, yours or MCP — goes through a filter that:

- blocks access to credential paths (the key store, SSH keys…),
- blocks catastrophic commands in the arguments,
- keeps `fetch_url` away from your internal network's addresses (anti-SSRF),
- and redacts secrets that show up in results.

The guard is not a sandbox: full isolation requires containers, and it is on the roadmap. Meanwhile, the practical rule is not to ask an agent for things you wouldn't let a script running as your user do.

**Important exception:** your add-ons in `my_addons/` are your code and run unrestricted.

## The network, closed by default

- Out of the box, the API listens **only on `127.0.0.1`**: nobody on your network can touch it.
- Opening it takes two explicit decisions: `HYDRA_HOST=0.0.0.0` **and** a `HYDRA_AUTH_TOKEN`. Without a token, it stays on loopback.
- Connections from the machine itself pay no token (a local process can already read your disk; asking it adds nothing). If you have a reverse proxy in front and want it always required: `HYDRA_AUTH_STRICT=1`.
- The token travels in the clear over HTTP: local network yes, internet no. For remote access, HTTPS or a VPN in front — see [Server mode](./10-server-mode.md).

## Reporting a security issue

Write to **security@hydraops.org** or use GitHub's private reporting (*Security* tab). Don't open a public issue. The detail of what is worth reporting is in the repository's [SECURITY.md](../../SECURITY.md).

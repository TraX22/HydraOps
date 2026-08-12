# Security policy

**English** | [Español](SECURITY_es.md)

## How to report a vulnerability

Write to **security@hydraops.org**, or use GitHub's **private vulnerability reporting**:
*Security* tab → *Report a vulnerability*. Both channels stay private until a fix exists.

> For the maintainer: GitHub reporting has to be enabled once in *Settings → Code
> security → Private vulnerability reporting*.

Please don't open a public issue for a security bug.

## What to expect

This is a single-maintainer project: a response may take days. Credit will be given to
reporters, unless they prefer otherwise.

## Current posture — read before reporting

These are not vulnerabilities; they are known, documented design decisions. A report
about them adds nothing new:

- **Connections from the machine itself pay no toll.** The API listens out of the box
  **on loopback only** (`127.0.0.1`), and opening it to the network is an explicit
  decision — `HYDRA_HOST=0.0.0.0` — that requires defining `HYDRA_AUTH_TOKEN` (without a
  token, the API stays on loopback). Loopback traffic is accepted without a token on
  purpose: a local process can already read the entire disk, so asking it for a token
  adds no security — and if a reverse proxy sits in front, there is
  `HYDRA_AUTH_STRICT=1`. The token travels in the clear over HTTP: it is meant for the
  local network; for access from the internet, put HTTPS or a VPN in front.
- **Agents execute tools.** That is what they do. The guard
  (`packages/addons/src/guard.ts`) blocks credential paths, catastrophic commands and
  requests to internal networks, and redacts secrets from results, but it is **not a
  sandbox**: real isolation requires containers, and it is on the roadmap.
- **Your own add-ons in `my_addons/` load and run unrestricted.** It is code you write;
  treat it as such.

What we very much do want to hear about: API-key leaks past the key-proxy, ways to bypass
the guard, path escapes when reading or writing files, SSRF in `fetch_url`, and any path
by which a prompt ends up executing something the user didn't ask for.

## Where the keys live

Real keys exist **only** in the key-proxy's store, outside the project
(`%APPDATA%\hydraops\keys.json` on Windows). Neither the repository, nor the database,
nor the `.env`, nor the worker processes ever see them: wherever a key should appear
there is a literal placeholder, `proxy`, and the substitution happens at the network
boundary.

If you find a real key anywhere else, **that is a bug** and deserves a report.

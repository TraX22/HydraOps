# Privacy Policy

**English** | [Español](PRIVACY_es.md)

_Last updated: 2026-08-13_

HydraOps is self-hosted software that runs entirely on your own machine. **The
HydraOps project does not collect, receive, store or transmit any of your data.**
There is no analytics, no telemetry, and no server operated by the project that
your installation talks to.

## Your data stays on your device

Everything you create or configure in HydraOps lives on the computer where you
install it:

- Agents and their personality files, your user profile, tasks and chat history,
  and file attachments are stored under your local application-data directory
  (`%APPDATA%\HydraOps` on Windows).
- **API keys are never sent to the project.** They are kept outside the
  application data, and a local credential proxy injects them only at the moment
  a request leaves your machine. The workers, the database and the configuration
  only ever see a `proxy` placeholder.

The project has no access to any of this. Uninstalling or updating HydraOps does
not send anything anywhere.

## Third-party services you choose to use

HydraOps is a tool for talking to AI models and other services. When you use it,
**your data is sent directly from your machine to the providers you configure,
using your own accounts and keys** — not through the project:

- **AI / model providers** (for example OpenAI, Anthropic, Google, Groq, xAI,
  Mistral, OpenRouter, Leonardo, or any local model server you run). The prompts,
  attachments and context you send are processed by whichever provider you
  select, under **that provider's own privacy policy and terms**.
- **Web and tool requests.** Some tools (such as fetching a URL) make outbound
  requests to the addresses you or your agents point them at.
- **Update checks.** The application asks GitHub for the latest published release
  so it can offer updates. GitHub receives the network request (including your IP
  address), as it would for any web request, under GitHub's own privacy policy.
  No account information or personal data is sent, and the check can be ignored
  or blocked without affecting the application.

Because these connections use your own credentials and go directly to those third
parties, how they handle your data is governed by their policies, not by HydraOps.

## Network exposure

By default the application listens only on your own machine (`127.0.0.1`) and is
not reachable from other devices. Opening it to your local network is optional and
requires you to set an access token. See the [Security policy](SECURITY.md) for
details.

## Changes to this policy

If this policy changes, the updated version will be published in this repository
with a new date above.

## Contact

Questions about privacy: **hi@hydraops.org**. Security issues:
**security@hydraops.org** (see [SECURITY.md](SECURITY.md)).

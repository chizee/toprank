# notfair-cmo

> Local AI marketing portal. Spin up specialist [OpenClaw](https://docs.openclaw.ai) marketing agents per project, chat with them, manage their scheduled work.

Open source. Runs entirely on your machine. Bring your own LLM credentials (via OpenClaw config) and your own ad-platform OAuth.

## What it gives you

- **Per-agent chat** scoped to each project — talk to a marketing-shaped agent that can launch campaigns, audit SEO, kick off cron jobs. Tool calls + MCP invocations stream inline as collapsible step rows.
- **Specialist agents** (CMO + Google Ads + SEO) auto-provisioned per project, isolated in their own OpenClaw workspaces. Clone or create more from the sidebar.
- A **cron tab** (calendar + list) that parses OpenClaw's cron list and groups it by project + agent so attribution is obvious.
- **Project-scoped MCP connections** — one-click PKCE OAuth to bring third-party tools (e.g. Google Ads via NotFair's hosted MCP) into the agents' toolbox without touching environment variables.
- An **Activity log** — every autonomous decision and scheduled run lands in an append-only audit trail.
- An **approvals inbox**, **autonomy guardrails**, and **task board** scaffolded for V1.1 (the SQLite tables and UI are in place; agent-side enforcement wires up in the next milestone).

## Prerequisites

- **[OpenClaw](https://docs.openclaw.ai/install)** installed and the gateway running on this machine (`openclaw gateway`).
- **Node 20+** (Node 24 recommended for native-module prebuilds).
- An LLM provider configured in your OpenClaw config (the project inherits `agents.defaults.model` — primary + fallbacks chain).

Run `notfair-cmo doctor` to verify all of the above plus your data dir and port.

## Install + run

```bash
# One-shot, no install:
npx notfair-cmo@latest doctor      # verify env
npx notfair-cmo@latest             # launch UI on http://127.0.0.1:3000

# Or install globally:
npm install -g notfair-cmo
notfair-cmo
```

The UI opens in your browser. Sidebar is project-scoped; create one to start.

## CLI

```
notfair-cmo                 Launch local server + open UI (default)
notfair-cmo start           Same as above
notfair-cmo doctor          Run preflight checks (see below)
notfair-cmo --version
notfair-cmo --help
```

Options on `start`: `--port <n>` (default 3000), `--no-open`, `--data-dir <path>`.
Options on `doctor`: `--port <n>`, `--data-dir <path>`.

`doctor` runs six checks in order: Node ≥ 20 (24 recommended), `openclaw` on
PATH, OpenClaw gateway reachable on loopback (defaults to `openclaw health`,
falls back to a TCP probe on `gateway.port`), an LLM provider configured per
`agents.defaults.model` (chain-aware: primary + fallbacks; either the OpenClaw
config or a recognized `*_API_KEY` env var counts as configured), the data dir
writable, and the preferred port free (probes the preferred port + 5 above
it). Exits 0 if all checks pass, 1 otherwise, with a `Fix:` line under each
failure naming the exact command to run.

## What happens when you create a project

1. SQLite row written at `~/.notfair-cmo/db.sqlite`.
2. Three OpenClaw agents provisioned under the project's slug:
   - `<slug>-cmo` — Chief Marketing Officer
   - `<slug>-google-ads` — Google Ads specialist
   - `<slug>-seo` — SEO specialist

   Each gets its own workspace at `~/.notfair-cmo/agents/<name>/` and an `IDENTITY.md` system prompt scoped to its role.
3. The onboarding stream walks you through the "magic moment" preview steps over SSE, then redirects to the project home. Click into any agent to start a thread.

## Scheduling recurring work

Agents have OpenClaw's built-in `exec` tool, so they create their own cron jobs by running `openclaw cron add ...` with our naming convention. You can also schedule manually via the **+ New cron** button on the Crons tab.

Cron names follow `<project-slug> / <agent-slug> / <cron-slug>` so the tab can group them and the calendar can lay them out.

## Connecting MCP servers (for live ad-platform data)

The Connections page lists the MCP servers in our catalog (currently:
NotFair Google Ads). Click **Connect** to start a one-click PKCE OAuth flow
— no environment variables to set, no Google Cloud project of your own to
register. The token is persisted into OpenClaw's `mcp` config under a
project-namespaced key, with `codex.agents` rewritten to that project's
agents so MCPs don't bleed across projects.

Direct env-var OAuth (Google Ads / GSC) has scaffold API routes at
`/api/oauth/[provider]/{start,callback}` for users who want to bring their
own Google Cloud OAuth client. There's no Connections-page UI for that path
in V1; it lands in V1.1 alongside the wider Search Console + GA4 surface.

OAuth refresh tokens are AES-256-GCM encrypted with a master key stored in
your OS keychain (via `keytar`) and persisted to your local SQLite.

## Data location

- App state: `~/.notfair-cmo/db.sqlite` (override with `--data-dir` or `NOTFAIR_CMO_DATA_DIR`)
- Agent workspaces: `~/.notfair-cmo/agents/<agent-name>/`
- OpenClaw config: `~/.openclaw/openclaw.json` (managed by OpenClaw, not us)

## What V1 is and isn't

**Is:** an agent runner + per-agent chat portal + cron management UI + MCP connection hub + activity audit log. Talk to project-scoped OpenClaw agents, schedule their recurring work, connect their tools, see attribution.

**Isn't (yet):** a fully autonomous CMO. The approvals inbox, autonomy guardrails enforcement, per-LLM-call cost tracking, eval harness, and cross-agent signal sharing are scaffolded but not wired end-to-end. They land in V1.1.

See `ARCHITECTURE.md` for the design and `CONTRIBUTING.md` for development setup.

## License

MIT — see LICENSE.

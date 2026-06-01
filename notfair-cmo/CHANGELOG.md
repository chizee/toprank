# notfair-cmo

## 0.4.0 — 2026-05-31

Redesigned Connections page + curated "Browse connectors" UX. The catalog now ships with a small directory of trusted MCPs you opt into; clicking a tile adds it to the project and starts OAuth in one step. The page itself was rebuilt as an editorial list with a top-right "Add server" menu.

**Connections page redesign.** Cards became list rows inside a single bordered container; sharper typographic hierarchy (eyebrow + large H1 + mono section labels); status communicated via small colored dot + small-caps mono label instead of pill backgrounds; the "Add server" affordance moved to the header.

**Browse connectors.** New dropdown menu on the header splits "Browse connectors" (curated grid of NotFair Google Ads, NotFair Meta Ads, Stripe, PostHog, Supabase, Mixpanel) and "Add custom connector" (paste-a-URL form). Tile click chains `addUserMcpServerAction` → `startMcpConnect` → browser redirect — no second click. Tiles for connectors already connected in the project render non-clickable with a green "connected" lozenge.

**Preset connectors are now removable.** New migration `012` adds `projects.hidden_mcp_preset_keys_json`. Removing a preset (e.g. NotFair Google Ads) hides it from the project's catalog and clears its token + adapter wiring; re-adding from Browse unhides it.

**OAuth fidelity fixes that shook out during dogfooding:**
- RFC 8414 §3.1 inserted form for AS metadata. Stripe's issuer `https://access.stripe.com/mcp` only resolves via the inserted variant.
- `client_secret_post` fallback when an AS doesn't advertise `none` as a token-endpoint auth method (Supabase). DCR registers as a confidential client; the callback already forwards `client_secret` at token exchange.
- `MCP-Protocol-Version: 2025-06-18` on every JSON-RPC call. Some servers (Supabase) 400 without it.
- Status probe uses spec-mandated `initialize` instead of `tools/list`. Tool count moves to on-demand fetch via the Tools dialog.
- `localhost` → `127.0.0.1` normalization on the redirect URI. RFC 8252 §7.3.
- HTTP-error response body is captured + surfaced in the unreachable message instead of just "HTTP 400".
- AS-metadata candidate-URL probing (RFC 8414 inserted, OIDC inserted, appended fallbacks).

**Idempotent add + URL-based dedup.** `addUserMcpServerAction` now accepts a canonical `key` override (used by Browse so "NotFair Google Ads" hits the preset key `notfair-googleads` instead of slugifying into a different identifier). The action also detects "this same MCP server URL is already in the project" and returns the existing key instead of writing a duplicate.

**Trusted connectors curated.** Vercel and Supabase were each verified end-to-end:
- Stripe, PostHog, Mixpanel: kept after URL corrections (most live at `/mcp`, not `/`).
- Supabase: kept after the `client_secret_post` fallback landed.
- Vercel: omitted. Their DCR endpoint silently returns a single fixed `client_id` and the authorize endpoint rejects every loopback redirect URI — only their first-party integrations work today.

**New components:** `browse-connectors-dialog`, `mcp-icon` (shared brand favicon via Google's faviconV2 service, subdomain-stripped to the registrable domain), `add-mcp-server-card` (now a `AddMcpServerMenu` dropdown trigger; the custom-URL dialog moved inside).

## 0.3.1 — 2026-05-31

User-configurable MCP catalog. The Connections page is no longer limited to the curated preset list — users can register any OAuth-2.0 MCP server (Stripe, Vercel, Supabase, or their own) by pasting a resource URL. The portal probes RFC 9728 protected-resource discovery + RFC 8414 AS metadata before persisting, so only servers that actually support dynamic client registration get past the form.

- New `user_mcp_servers` SQLite table (migration `011`), project-scoped, joined with `MCP_CATALOG_PRESETS` by the new `getMcpCatalog(project_slug)` helper.
- `mcpSpecByKey` is now project-scoped (`(project_slug, key)`); all call sites updated.
- New server actions: `probeMcpDiscovery`, `addUserMcpServerAction`, `removeUserMcpServerAction`.
- New "Add an MCP server" card on the Connections page; user-added cards get a "Remove server" affordance presets don't have.
- `cascadeDeleteProjectArtifacts` cleans up `user_mcp_servers` rows on project deletion and unregisters the adapter rows for both presets and user-added entries.

## 0.3.0 — 2026-06-01

End-to-end wiring + reliability pass on top of the 0.2.0 harness-agnostic rewrite. Every surface in the app is now driven by a real, persisted code path; no more half-finished stubs.

### Agents can actually use the tools they're given

- **`schedule_recurring_work` MCP tool** — agents create real rows in `scheduled_jobs` instead of shelling out to a CLI that no longer exists. Skill prompt rewritten to teach the tool; the dead `openclaw cron add` block is gone.
- **Codex MCP auth fixed** — Codex 0.132+ rejects raw `headers.Authorization` rows as `Auth: Unsupported`. Registration now writes `bearer_token_env_var`; spawn injects one env var per server. Orchestration keeps its dedicated `NOTFAIR_ORCHESTRATION_BEARER` for backward compat.
- **Codex sandbox bypass** — adapter spawns Codex with `--dangerously-bypass-approvals-and-sandbox` so MCP tool calls aren't silently cancelled and loopback to the local orchestration server actually works.
- **External MCPs reach agents on OAuth complete** — `setMcpBearer` now also calls `registerCatalogMcpForProject`, wiring the new bearer into every agent's harness config. New agents provisioned later also inherit existing project tokens.
- **Per-server env var scheme** (`NOTFAIR_MCP_BEARER__<SERVER>`) so multiple MCPs can coexist with different bearers in the same Codex spawn.

### Live transcript: paperclip-style pub/sub

- In-process `EventEmitter` keyed by `session_id`. `appendTranscriptEvent` publishes after every INSERT.
- SSE bridge (`/api/agents/.../live`) subscribes instead of polling. Sub-millisecond push latency for chat / tool / lifecycle events.
- Reattach is race-free: backfill from `cursor=0` runs *after* the subscription is attached, with events buffered during the backfill and dedup-by-seq on flush.
- Verified end-to-end via curl SSE alongside the chat composer: each new event arrives in its own SSE frame, in order.

### Recover from agent silence

- New "abandoned task" state surfaced when the harness turn ends cleanly but the agent forgot to call `submit_task_status`. Previously this stranded the task in `working` with an infinite "Wrapping up" spinner.
- Recovery card with three explicit actions:
  - **Resume** — flip back to `proposed` and re-fire the kickoff (transcript preserved).
  - **Mark done** — close the task manually.
  - **Cancel** — terminate.
- New `resumeBlockedTaskAction` and `markTaskDoneAction` server actions.
- Working indicator gets a `mood: "ended"` palette so the spinner doesn't lie during the parked state.

### Sidebar no longer flickers

- Replaced `router.refresh()`-driven badge updates with a client `LiveCountsProvider` polling `/api/in-flight-counts` and pushing fresh numbers through React Context.
- Sidebar's server-rendered structure never reconciles between polls — only the badge nodes flip. Zero flicker across multiple polling cycles.
- `GlobalLivenessPoller` removed entirely; superseded by the context provider.
- `startTransition` wraps remaining `router.refresh()` calls in the task workspace + start-all flows.

### Bug fixes

- **Project delete FK violation** — `deleteProjectRow` and `changeProjectSlug` were missing `questions`, `mcp_tokens`, `scheduled_jobs`, `sessions` in their child-table lists. Added; regression test now seeds every FK-bearing table.
- **Reattach session-mismatch** — chat composer sends `sessionId` matching the URL UUID, but the chat route read `body.thread` and fell back to `"main"`. Now honors both fields with `sessionId` as the canonical thread label.
- **Project isolation: agent-prefix collision** — `listProjectAgents` matched dirs by string prefix; project "acme" leaked agents from "acme-q4". Now filtered by the sidecar's `project_slug` field. Test asserts the cross-leak no longer happens.
- **Session lookup scoped to project** — `findSessionBySessionId` now requires `project_slug` to close the same prefix-collision class of bugs.
- **Files tab dedup** — `PROJECT.md` was appearing twice from a legacy augment step. Removed; field shape on `AgentFileEntry` aligned to UI expectations.

### Removed user-visible "OpenClaw" copy

- Home page, agents page, crons header / error, agent cron header / error, skills header / error, mcp-card, schedule-cron-dialog, create-agent-dialog, danger-zone, agent-danger-zone — all rewritten to describe what's actually running (workspace dirs, scheduled jobs, harness adapters).

### Internal

- `notfair-cmo doctor` drops the OpenClaw / gateway / LLM-config probes; now checks Claude Code + Codex per adapter, requires at least one.
- `agents/files.ts` simplified — fs reader returns every workspace file in one pass.
- 870 tests, 73 test files. Adapter parsers, MCP config writers (Claude Code + Codex), pub/sub emitter, scheduler tool, project delete cascade, sidebar live-counts context, abandoned-task UI flows all covered.

### Migrating from 0.2.0

No DB migration required (the schema landed in 0.2.0). The OAuth callback now auto-registers the catalog MCP with every agent — if you previously connected an MCP that wasn't visible to your agents, just **disconnect and reconnect** from `/<project>/connections` and Greg / Ana will pick it up.

## 0.2.0 — 2026-05-31

### Harness-agnostic rewrite

notfair-cmo is no longer coupled to OpenClaw. Agents run through pluggable
harness adapters — Claude Code (default) and Codex ship as the first two
supported options, and the architecture is open for more.

**Architecture**

- `HarnessAdapter` interface + adapter registry + UI display registry under
  `src/server/adapters/`. Mirrors paperclip's adapter pattern.
- Two adapters fully implemented:
  - `claude-code-local` — spawns `claude --output-format stream-json`,
    parses events, writes workspace `IDENTITY.md`/`CLAUDE.md`, and registers
    MCP servers via `.mcp.json`.
  - `codex-local` — spawns `codex exec --json`, writes workspace
    `IDENTITY.md`/`AGENTS.md`, registers MCP servers in
    `~/.codex/config.toml`.
- Migration `010_harness_adapter.sql` adds `projects.harness_adapter` plus
  five new tables (`mcp_tokens`, `scheduled_jobs`, `scheduled_job_runs`,
  `sessions`, `transcript_events`).
- Native runtime services replace every OpenClaw dependency:
  - **Sessions / transcripts**: `src/server/sessions/` — SQLite rows backed
    by `transcript_events`, plus `view.ts` for the thread dropdown and
    `transcript-tail.ts` for the live SSE bridge.
  - **Scheduler**: `src/server/scheduler/` — cron-parser tick loop, schedule
    rows in `scheduled_jobs`, runs in `scheduled_job_runs`. The tick loop
    dispatches due jobs through the project's adapter.
  - **MCP token storage**: `src/server/mcp/tokens.ts` — project-scoped tokens
    in SQLite, surfaced via `mcp/state.ts` (`getMcpStatus`, `setMcpBearer`,
    `disconnectMcp`).
  - **Agent provisioning**: `src/server/agents/{provisioning,clone,
    cascade-delete,files,skills}.ts` — workspace ownership and
    create / clone / delete entirely in fs + SQLite.

**Routes + UI rewired**

- `/api/chat` dispatches through the project's harness adapter and persists
  every event to `transcript_events`.
- `/api/agents/.../threads/.../live` polls `transcript_events` at 500 ms and
  streams new rows as SSE — no shadow JSONL anymore.
- `/api/agents/.../threads/.../transcript` reads the same table by `seq`
  cursor for paged tail.
- `/api/mcp-oauth/callback` writes tokens straight into `mcp_tokens`.
- Onboarding flow shows a recommended-harnesses picker (Claude Code default,
  Codex available) with paperclip-style "Recommended" badges. Choice persists
  on the project row.
- `agent-templates.ts` provisions every agent through the chosen adapter and
  registers the notfair-orchestration MCP per-agent at provision time.
- Orchestration wake-ups (`run-task.ts`, `approval-wakeup.ts`,
  `question-wakeup.ts`) all dispatch via adapter + persist to
  `transcript_events`.

**bin/cli.mjs**

- `notfair-cmo doctor` checks Claude Code and Codex separately, requires at
  least one of them on PATH, and drops every former `openclaw --version` /
  gateway / LLM-config probe.

**Deleted**

- `src/server/openclaw/` — entire directory (24 files) including
  `cli.ts`, `gateway-client.ts`, `gateway-rpc.ts`, `crons.ts`,
  `cron-schedule.ts`, `sessions.ts`, `transcript-tail.ts`,
  `shadow-transcript.ts`, `thread-origins.ts`, `clone-agent.ts`,
  `project-delete.ts`, `agent-turn.ts`.
- `src/server/mcp-state.ts` (replaced by `src/server/mcp/state.ts`).
- `src/components/paired-openclaw-pill.tsx` and the sidebar footer that hosted it.
- Legacy tests that mocked the removed modules (8 test files removed; will
  be re-added with adapter-aware coverage as the new surfaces stabilise).

**Tests**

- 852 tests passing across 69 files.
- New adapter parsers (`claude-code-local/parse`, `codex-local/parse`)
  have dedicated coverage.
- Full test suite + dev server boot verified after every migration step.

## 0.1.0

Initial OpenClaw-coupled release.

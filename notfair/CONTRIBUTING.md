# Contributing

Thanks for poking around! NotFair is small, opinionated, and willing to grow.

## Dev setup

The app lives in the `notfair/` directory of the [nowork-studio/NotFair](https://github.com/nowork-studio/NotFair) repo:

```bash
git clone https://github.com/nowork-studio/NotFair.git
cd NotFair/notfair
pnpm install
```

Native deps (`better-sqlite3`, `keytar`) need build approvals on pnpm — already
configured in `package.json` under `pnpm.onlyBuiltDependencies`, so they build
on install with no extra prompts.

Make sure you have:
- Node 20+ (24 preferred — that's what the prebuilt `better-sqlite3` / `keytar` binaries target)
- At least one harness installed and authenticated: [Claude Code](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview) (`claude`) or [Codex CLI](https://github.com/openai/codex) (`codex`)

Quickest way to verify the host machine is set up is the doctor, which the
shipped CLI exposes and which you can run against the dev source too:

```bash
pnpm cli doctor             # same checks the published `notfair doctor` runs
```

## Dev loop

```bash
pnpm dev          # next dev --turbopack on port 3326 (the published CLI serves on 3327)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # next build + scripts/copy-standalone-assets.mjs (npm-tarball-ready)
pnpm cli          # the CLI (start, doctor) from your checkout — start needs a pnpm build first
```

`pnpm dev` is the day-to-day. The dev server points at the same
`~/.notfair/db.sqlite` as a globally installed `notfair` does, so if
you also run the published CLI on this machine, point one of them at a
different data dir to avoid stomping each other's state:

```bash
NOTFAIR_DATA_DIR=$PWD/.notfair-dev pnpm dev
```

`.notfair-dev/` is already gitignored.

To reset local state for a clean run, stop any running server and:

```bash
rm ~/.notfair/db.sqlite                    # blow away product state
rm -rf ~/.notfair/agents/                  # blow away agent workspaces
```

There is no migration system: the entire schema lives in
`src/server/db/schema.ts` and is applied idempotently on boot. Schema changes
edit that file; dev databases are recreated, not migrated.

## Project shape

See `ARCHITECTURE.md`. Short version:
- Frontend: Next.js 16 App Router + React 19 + Tailwind 4 + shadcn/ui primitives, styled per `DESIGN.md`
- Backend: Next.js server actions + SQLite (`better-sqlite3` at `~/.notfair/db.sqlite`) + the goal-loop runtime under `src/server/goals/`
- Harness-agnostic: goal agents run on any local AI coding agent that implements the `HarnessAdapter` contract in `src/server/adapters/` — Claude Code (`claude-code-local`) and Codex (`codex-local`) today
- NotFair hosts two internal MCP servers as Next routes — `notfair-goals` (`/api/mcp/goals`, the goal tools) and `notfair-browser` (`/api/mcp/browser`) — and connects external catalog MCPs (Google Ads, Search Console, PostHog, …) per project via the Connections page

## Adding a feature

1. Open an issue describing the user-facing change (the *what* and *why*).
2. Branch off `main`.
3. Build it. Keep modules small. shadcn primitives over custom CSS; follow `DESIGN.md`.
4. Run `pnpm typecheck && pnpm test && pnpm build`. All three must pass.
5. Live smoke: `pnpm dev`, then walk the affected flow in the browser (goal index → goal page → chat / confirm / checks). Prompt-affecting changes (`src/server/goals/identity.ts`, tick briefs in `src/server/goals/tick.ts`, tool descriptions in `src/server/mcp-server/tools.ts`) must be validated by running a real goal loop end-to-end and reading the agent's actual behavior in the transcript. `scripts/e2e-provision.ts` is a starting point for spinning up a fresh project + agents from a script.
6. Update README / ARCHITECTURE if behavior changed.
7. Open a PR. Describe what you changed and how to verify.

## Module conventions

- **Server-only modules** live in `src/server/`. Anything in there can use `node:*` modules + native deps.
- **Client components**: start the file with `"use client";`.
- **Server actions**: `"use server";`. Throw on validation failure (form actions) or return discriminated `{ ok: true, ... } | { ok: false, error }` (programmatic).
- **Database access**: only via helpers in `src/server/db/`. Don't reach for `getDb()` from a component or route.
- **Harness access**: only via the adapter registry (`src/server/adapters/`). Don't spawn `claude` or `codex` directly from a route — adapters own process lifecycle, workspace config, and MCP registration.
- **Slugs**: only via `src/lib/slug.ts`. Reserved words checked.
- **Types**: shared types go in `src/types/`. Server-only types stay near their server module.

## Style

- TypeScript strict mode. No `any` unless interfacing with untyped externals.
- Prefer named exports. Default exports only for Next.js pages/layouts/route handlers.
- Visual language lives in `DESIGN.md` — surfaces are separated by elevation (shadow/surface tokens), not borders; use the existing `ns-*` utility classes before inventing new ones.
- No comments unless the *why* is non-obvious. Identifiers do the explaining; PR descriptions carry the context.

## Testing

`pnpm test` runs the Vitest suite. Conventions:

- Tests live next to the code they cover (`src/lib/foo.ts` → `src/lib/foo.test.ts`).
- Default environment is node; component tests opt into a DOM with a leading `// @vitest-environment jsdom` pragma and use `@testing-library/react`.
- Mock at the server-action / db-module boundary (`vi.mock`), not deeper.
- SQLite tests run the real `better-sqlite3` against a tmpdir. The `NOTFAIR_DATA_DIR` override MUST be set inside `vi.hoisted(...)` — static imports evaluate before module-level statements, so a plain assignment would point the suite at your live `~/.notfair`.
- Test pure logic and user-visible component behavior; don't unit-test Next.js pages or route handlers — the live smoke covers those.

## Commits + PRs

- One logical change per commit. Conventional commits with type-scope-description: `feat(goals): backfill metric history at intake`, `fix(tick): clamp smart sleep to deadline`. Look at `git log` — recent history is the template.
- When AI-assisted, credit the model with a co-author trailer, e.g.:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

- Never bypass hooks (`--no-verify`), never skip signing, never force-push without an explicit ask.
- Don't commit secrets. If a `.env`, OAuth token, or API key shows up in a diff, stop and fix the diff before pushing.

## License

By contributing, you agree your contributions are licensed under MIT.

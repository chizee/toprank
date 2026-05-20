// Embedded migration manifest. The canonical SQL lives in migrations/*.sql for
// readability and editor tooling; this file is a small generated mirror so the
// production build doesn't need filesystem access to apply migrations.
//
// To add a migration:
//   1. Write src/server/db/migrations/00N_<name>.sql
//   2. Append an entry below with the SAME contents (order = apply order)
//   3. CI lint (TODO) keeps the two in sync

export type Migration = {
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [
  {
    name: "001_init.sql",
    sql: `
-- notfair-cmo SQLite schema, migration 001.
-- Forward-only; do not edit after release. New changes go in a new numbered migration.

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

-- Task lifecycle:
-- proposed -> approved -> running -> (succeeded | failed | cancelled)
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_slug     TEXT NOT NULL REFERENCES projects(slug),
  agent_id         TEXT NOT NULL,
  brief            TEXT NOT NULL,
  success_criteria TEXT,
  deadline_iso     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('proposed','approved','running','succeeded','failed','cancelled')),
  result_json      TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_slug, status);

CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug),
  agent_id          TEXT NOT NULL,
  action_summary    TEXT NOT NULL,
  action_type       TEXT NOT NULL CHECK (action_type IN ('spend','content_publishing','new_channel','bid_change','audience_change','other')),
  cost_estimate_usd REAL NOT NULL DEFAULT 0,
  reasoning         TEXT,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(project_slug, status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS cost_events (
  id           TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  agent_id     TEXT,
  source       TEXT NOT NULL CHECK (source IN ('llm','google_ads','gsc','other')),
  amount_usd   REAL NOT NULL,
  ref          TEXT,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_events_project_time ON cost_events(project_slug, occurred_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug),
  provider          TEXT NOT NULL CHECK (provider IN ('google_ads','gsc')),
  account_label     TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(project_slug, provider, account_label)
);

CREATE TABLE IF NOT EXISTS guardrails (
  project_slug TEXT PRIMARY KEY REFERENCES projects(slug),
  config_json  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug),
  agent_id      TEXT NOT NULL,
  task_id       TEXT,
  action_type   TEXT NOT NULL,
  summary       TEXT NOT NULL,
  reasoning     TEXT,
  payload_json  TEXT,
  occurred_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_project_time ON agent_actions(project_slug, occurred_at);

CREATE TABLE IF NOT EXISTS sequence_runs (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug),
  agent_id      TEXT NOT NULL,
  sequence_kind TEXT NOT NULL,
  cursor        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  payload_json  TEXT,
  last_tick_at  TEXT,
  next_tick_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`,
  },
  {
    name: "002_google_ads_account.sql",
    sql: `
-- Per-project Google Ads account selection. Bearers from notfair.co's MCP
-- can grant access to multiple customer accounts; onboarding asks the user
-- to pick one and persists it here so the audit + later automation always
-- target the right account.
ALTER TABLE projects ADD COLUMN google_ads_account_id TEXT;
`,
  },
  {
    name: "003_tasks_orchestration.sql",
    sql: `
-- Tasks gain three columns to power the autonomous CMO orchestrator:
--
--   title              — short label distinct from the long brief, shown
--                        on /tasks cards + task detail header.
--   thread_id          — the OpenClaw chat session id this task's
--                        per-task thread runs under. The assignee picks
--                        up the task in this thread (TASK_BRIEF.md
--                        kickoff). Null until the user (or the CMO
--                        autonomously) opens the detail page; populated
--                        once and immutable.
--   assigner_agent_id  — who created this task. CMO assigns to specialists;
--                        in v1.1 specialists can create sub-tasks and
--                        this lets us walk the chain back to the planner.
ALTER TABLE tasks ADD COLUMN title TEXT;
ALTER TABLE tasks ADD COLUMN thread_id TEXT;
ALTER TABLE tasks ADD COLUMN assigner_agent_id TEXT;
`,
  },
  {
    name: "004_task_display_id.sql",
    sql: `
-- Human-readable per-project task IDs (e.g. demo7-3) shown in the UI and
-- used in URLs. PK stays as the UUID for FK integrity / agent protocol;
-- display_id is the surface that humans + URLs see.
--
-- Backfill assigns sequential numbers in created_at order per project,
-- so existing demos get pretty IDs without manual cleanup.
ALTER TABLE tasks ADD COLUMN display_id TEXT;

WITH numbered AS (
  SELECT
    id,
    project_slug || '-' || ROW_NUMBER() OVER (
      PARTITION BY project_slug ORDER BY created_at
    ) AS dn
  FROM tasks
)
UPDATE tasks
SET display_id = numbered.dn
FROM numbered
WHERE tasks.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_display_id ON tasks(display_id);
`,
  },
];

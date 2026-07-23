import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "./db";

/**
 * Data layer for the goal-driven agent loop.
 *
 * The goal row IS the loop's state machine — the agent's context window is
 * disposable, so everything a tick needs to orient (metric spec, open
 * actions, learnings, history) lives here. Status flow:
 *
 *   intake ──▶ proposed ──▶ active ⇄ paused
 *                              │
 *                              ▼
 *                 achieved | failed | killed   (terminal)
 *
 * intake   — goal agent is authoring + testing the metric query
 * proposed — metric verified server-side, baseline measured; awaiting the
 *            user's confirmation of target/deadline/envelope
 * active   — heartbeat ticks run on cadence_cron
 */

export type GoalStatus =
  | "intake"
  | "proposed"
  | "active"
  | "paused"
  | "achieved"
  | "failed"
  | "killed";

export const GOAL_LIVE_STATUSES: GoalStatus[] = [
  "intake",
  "proposed",
  "active",
  "paused",
];

export const GOAL_TERMINAL_STATUSES: GoalStatus[] = [
  "achieved",
  "failed",
  "killed",
];

export type MetricDirection = "increase" | "decrease";

/** achieve = complete when the target is reached. maintain = hold the
 *  number there indefinitely; target met is the steady state. */
export type GoalMode = "achieve" | "maintain";

export type Goal = {
  id: string;
  project_slug: string;
  agent_id: string;
  statement: string;
  /** Compact display label ("Wasted X spend → $0"), written by the agent
   *  during define_goal. Display falls back to a trimmed statement. */
  short_label: string | null;
  status: GoalStatus;
  status_reason: string | null;
  metric_name: string | null;
  metric_source_key: string | null;
  metric_source_tool: string | null;
  metric_source_args_json: string | null;
  metric_direction: MetricDirection | null;
  baseline_value: number | null;
  current_value: number | null;
  target_value: number | null;
  mode: GoalMode;
  deadline: string | null;
  spend_envelope_usd: number | null;
  cadence_cron: string;
  next_tick_at: string | null;
  last_tick_at: string | null;
  tick_count: number;
  created_at: string;
  updated_at: string;
};

export type GoalActionKind = "mutation" | "research" | "decision";
export type GoalActionStatus = "open" | "reviewed" | "abandoned";

export type GoalAction = {
  id: string;
  goal_id: string;
  tick_number: number | null;
  kind: GoalActionKind;
  description: string;
  resources_touched_json: string;
  expected_effect: string;
  review_after: string | null;
  spend_usd: number | null;
  status: GoalActionStatus;
  observed_outcome: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type GoalMetricSnapshot = {
  id: string;
  goal_id: string;
  value: number;
  source: "intake" | "tick" | "manual" | "backfill";
  created_at: string;
};

export type GoalLearning = {
  id: string;
  goal_id: string;
  body: string;
  confidence: "low" | "medium" | "high";
  superseded_by: string | null;
  created_at: string;
};

export type GoalTickTrigger = "heartbeat" | "manual" | "approval" | "intake";
export type GoalTickStatus = "running" | "done" | "failed";

export type GoalTick = {
  id: string;
  goal_id: string;
  tick_number: number;
  trigger_kind: GoalTickTrigger;
  owner_pid: number | null;
  session_id: string | null;
  metric_value: number | null;
  metric_error: string | null;
  status: GoalTickStatus;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function computeNextTick(cron_expr: string, from = new Date()): string | null {
  try {
    const it = CronExpressionParser.parse(cron_expr, { currentDate: from, tz: "UTC" });
    return it.next().toISOString();
  } catch {
    return null;
  }
}

// ── goals ────────────────────────────────────────────────────────────────

export type CreateGoalInput = {
  project_slug: string;
  agent_id: string;
  /** Empty at agent creation — the user articulates it in chat and the
   *  agent records it via the define_goal tool. */
  statement?: string;
  deadline?: string | null;
  spend_envelope_usd?: number | null;
  cadence_cron?: string;
};

/**
 * Insert a new goal in `intake`. Agent = goal: each agent owns exactly one
 * live goal (partial unique index on agent_id enforces it at the DB level;
 * we pre-check to control the message).
 */
export function createGoal(input: CreateGoalInput): Goal {
  const db = getDb();
  if (getGoalForAgent(input.agent_id)) {
    throw new Error(
      `Agent '${input.agent_id}' already has a live goal.`,
    );
  }
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO goals
       (id, project_slug, agent_id, statement, status, cadence_cron,
        deadline, spend_envelope_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'intake', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_slug,
    input.agent_id,
    input.statement ?? "",
    input.cadence_cron ?? "0 16 * * *",
    input.deadline ?? null,
    input.spend_envelope_usd ?? null,
    ts,
    ts,
  );
  return getGoal(id)!;
}

export function getGoal(id: string): Goal | null {
  const row = getDb().prepare("SELECT * FROM goals WHERE id = ?").get(id);
  return (row as Goal) ?? null;
}

/** The agent's one live goal (intake/proposed/active/paused), if any. */
export function getGoalForAgent(agent_id: string): Goal | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM goals
        WHERE agent_id = ?
          AND status IN ('intake','proposed','active','paused')
        LIMIT 1`,
    )
    .get(agent_id);
  return (row as Goal) ?? null;
}

/** The agent's most recent goal, any status — terminal goals stay visible
 *  on the agent's page as history (the achievement IS the payoff). */
export function getLatestGoalForAgent(agent_id: string): Goal | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM goals WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(agent_id);
  return (row as Goal) ?? null;
}

/** Every live goal in the project — one per agent. */
export function listLiveGoals(project_slug: string): Goal[] {
  return getDb()
    .prepare(
      `SELECT * FROM goals
        WHERE project_slug = ?
          AND status IN ('intake','proposed','active','paused')
        ORDER BY created_at ASC`,
    )
    .all(project_slug) as Goal[];
}

/**
 * Chat-intake step 1: record what the user wants (statement) plus any
 * constraints they stated. Only while the goal is still in intake.
 */
export function defineGoal(
  id: string,
  input: {
    statement: string;
    short_label?: string | null;
    deadline?: string | null;
    spend_envelope_usd?: number | null;
  },
): Goal | null {
  const r = getDb()
    .prepare(
      `UPDATE goals
          SET statement = ?, short_label = COALESCE(?, short_label),
              deadline = COALESCE(?, deadline),
              spend_envelope_usd = COALESCE(?, spend_envelope_usd), updated_at = ?
        WHERE id = ? AND status = 'intake'`,
    )
    .run(
      input.statement,
      input.short_label ?? null,
      input.deadline ?? null,
      input.spend_envelope_usd ?? null,
      now(),
      id,
    );
  if (r.changes === 0) return null;
  return getGoal(id);
}

export function listGoals(project_slug: string): Goal[] {
  return getDb()
    .prepare("SELECT * FROM goals WHERE project_slug = ? ORDER BY created_at DESC")
    .all(project_slug) as Goal[];
}

export type GoalMetricSpec = {
  metric_name: string;
  metric_source_key: string;
  metric_source_tool: string;
  metric_source_args_json: string;
  metric_direction: MetricDirection;
  baseline_value: number;
};

/**
 * Intake result: the verified metric definition + measured baseline.
 * Moves intake → proposed. No-op (returns null) if the goal isn't in
 * intake — proposing twice or after activation is a bug upstream.
 */
export function setGoalMetric(id: string, spec: GoalMetricSpec): Goal | null {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE goals
          SET metric_name = ?, metric_source_key = ?, metric_source_tool = ?,
              metric_source_args_json = ?, metric_direction = ?,
              baseline_value = ?, current_value = ?,
              status = 'proposed', updated_at = ?
        WHERE id = ? AND status = 'intake'`,
    )
    .run(
      spec.metric_name,
      spec.metric_source_key,
      spec.metric_source_tool,
      spec.metric_source_args_json,
      spec.metric_direction,
      spec.baseline_value,
      spec.baseline_value,
      now(),
      id,
    );
  if (r.changes === 0) return null;
  return getGoal(id);
}

export type ProposeTargetInput = {
  target_value: number;
  mode?: GoalMode;
  deadline?: string | null;
  spend_envelope_usd?: number | null;
  cadence_cron?: string;
};

/**
 * The user's confirmation, recorded from chat: target/cadence/envelope
 * land on the `proposed` goal and the loop goes live in the same step —
 * proposed → active with the first heartbeat scheduled. The caller fires
 * an immediate first tick.
 */
export function proposeTarget(id: string, input: ProposeTargetInput): Goal | null {
  const goal = getGoal(id);
  if (!goal || goal.status !== "proposed") return null;
  const cadence = input.cadence_cron ?? goal.cadence_cron;
  const nextTick = computeNextTick(cadence);
  if (!nextTick) {
    throw new Error(`Invalid cadence cron expression: '${cadence}'`);
  }
  getDb()
    .prepare(
      `UPDATE goals
          SET target_value = ?, mode = ?, deadline = ?, spend_envelope_usd = ?,
              cadence_cron = ?, status = 'active', next_tick_at = ?, updated_at = ?
        WHERE id = ? AND status = 'proposed'`,
    )
    .run(
      input.target_value,
      input.mode ?? goal.mode ?? "achieve",
      input.deadline ?? goal.deadline,
      input.spend_envelope_usd ?? goal.spend_envelope_usd,
      cadence,
      nextTick,
      now(),
      id,
    );
  return getGoal(id);
}

export type AmendGoalInput = {
  target_value?: number;
  deadline?: string | null;
  spend_envelope_usd?: number | null;
  cadence_cron?: string;
};

/**
 * Adjust a LIVE goal's parameters — "raise my envelope to $3k", "make the
 * target 25" are normal asks and must not require killing the goal.
 * Allowed while active or paused; recomputes the heartbeat when the
 * cadence changes on an active goal.
 */
export function amendGoal(id: string, input: AmendGoalInput): Goal | null {
  const goal = getGoal(id);
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return null;
  const cadence = input.cadence_cron ?? goal.cadence_cron;
  const cadenceChanged = cadence !== goal.cadence_cron;
  if (cadenceChanged && !computeNextTick(cadence)) {
    throw new Error(`Invalid cadence cron expression: '${cadence}'`);
  }
  const nextTick =
    goal.status === "active"
      ? cadenceChanged
        ? computeNextTick(cadence)
        : goal.next_tick_at
      : null;
  getDb()
    .prepare(
      `UPDATE goals
          SET target_value = COALESCE(?, target_value),
              deadline = COALESCE(?, deadline),
              spend_envelope_usd = COALESCE(?, spend_envelope_usd),
              cadence_cron = ?, next_tick_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      input.target_value ?? null,
      input.deadline ?? null,
      input.spend_envelope_usd ?? null,
      cadence,
      nextTick,
      now(),
      id,
    );
  return getGoal(id);
}

/**
 * Rename the goal's display label. Works in any status — a closed goal's
 * label is still the user's handle for it in history views.
 */
export function renameGoal(id: string, short_label: string): Goal | null {
  const r = getDb()
    .prepare("UPDATE goals SET short_label = ?, updated_at = ? WHERE id = ?")
    .run(short_label, now(), id);
  if (r.changes === 0) return null;
  return getGoal(id);
}

/**
 * Hard-delete an agent's goal rows. FK cascades take actions, snapshots,
 * learnings, ticks, PRs, and pins with them. Agent = goal, so callers pair
 * this with the agent's workspace/session cascade.
 */
export function deleteGoalsForAgent(agent_id: string): number {
  return getDb().prepare("DELETE FROM goals WHERE agent_id = ?").run(agent_id).changes;
}

// ── pins ─────────────────────────────────────────────────────────────────

export function setGoalPinned(id: string, pinned: boolean): void {
  const db = getDb();
  if (pinned) {
    db.prepare(
      "INSERT OR IGNORE INTO goal_pins (goal_id, created_at) VALUES (?, ?)",
    ).run(id, now());
  } else {
    db.prepare("DELETE FROM goal_pins WHERE goal_id = ?").run(id);
  }
}

/** Pinned goal ids for a project (sidebar sorts these first). */
export function getPinnedGoalIds(project_slug: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT p.goal_id FROM goal_pins p
        JOIN goals g ON g.id = p.goal_id
        WHERE g.project_slug = ?`,
    )
    .all(project_slug) as Array<{ goal_id: string }>;
  return new Set(rows.map((r) => r.goal_id));
}

/** Total incremental spend the agent has logged (non-abandoned actions). */
export function loggedSpendTotal(goal_id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(spend_usd), 0) AS total FROM goal_actions
        WHERE goal_id = ? AND status != 'abandoned'`,
    )
    .get(goal_id) as { total: number };
  return row.total;
}

/**
 * Open, still-gated actions belonging to OTHER live goals in the same
 * project. Their resources are just as untouchable — two agents sharing
 * an ad account must not thrash each other's experiments.
 */
export function listGatedActionsForOtherAgents(
  project_slug: string,
  goal_id: string,
  nowIso = now(),
): Array<GoalAction & { agent_id: string }> {
  return getDb()
    .prepare(
      `SELECT ga.*, g.agent_id FROM goal_actions ga
        JOIN goals g ON g.id = ga.goal_id
        WHERE g.project_slug = ? AND g.id != ?
          AND g.status IN ('active','paused')
          AND ga.status = 'open'
          AND ga.review_after IS NOT NULL AND ga.review_after > ?
        ORDER BY ga.review_after ASC`,
    )
    .all(project_slug, goal_id, nowIso) as Array<GoalAction & { agent_id: string }>;
}

/**
 * Status transitions outside the intake→proposed→active happy path:
 * pause/resume and the three terminal states. Terminal states are
 * one-way — a closed goal is history, not a resumable draft.
 */
export function setGoalStatus(
  id: string,
  status: Extract<GoalStatus, "active" | "paused" | "achieved" | "failed" | "killed">,
  reason?: string | null,
): Goal | null {
  const goal = getGoal(id);
  if (!goal) return null;
  if (GOAL_TERMINAL_STATUSES.includes(goal.status)) return goal; // no rewrites
  // Resuming (→ active) restarts the heartbeat; anything else stops it.
  const nextTick = status === "active" ? computeNextTick(goal.cadence_cron) : null;
  getDb()
    .prepare(
      `UPDATE goals
          SET status = ?, status_reason = ?, next_tick_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(status, reason ?? null, nextTick, now(), id);
  return getGoal(id);
}

/** Active goals whose heartbeat is due. Mirrors scheduler dueJobs(). */
export function dueGoals(nowIso = now()): Goal[] {
  return getDb()
    .prepare(
      `SELECT * FROM goals
        WHERE status = 'active'
          AND next_tick_at IS NOT NULL
          AND next_tick_at <= ?`,
    )
    .all(nowIso) as Goal[];
}

/**
 * Advance the heartbeat the moment a tick starts (double-fire guard —
 * same pattern as scheduler markJobRun) and bump the loop counters.
 * Returns the tick_number this tick should use.
 */
export function markGoalTicked(id: string): number {
  const db = getDb();
  const goal = getGoal(id);
  if (!goal) throw new Error(`goal not found: ${id}`);
  const ts = now();
  const nextTick = computeNextTick(goal.cadence_cron);
  db.prepare(
    `UPDATE goals
        SET last_tick_at = ?, next_tick_at = ?, tick_count = tick_count + 1,
            updated_at = ?
      WHERE id = ?`,
  ).run(ts, nextTick, ts, id);
  return goal.tick_count + 1;
}

export function updateGoalCurrentValue(id: string, value: number): void {
  getDb()
    .prepare("UPDATE goals SET current_value = ?, updated_at = ? WHERE id = ?")
    .run(value, now(), id);
}

// ── metric snapshots ─────────────────────────────────────────────────────

export function recordMetricSnapshot(
  goal_id: string,
  value: number,
  source: GoalMetricSnapshot["source"] = "tick",
): GoalMetricSnapshot {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.prepare(
    "INSERT INTO goal_metric_snapshots (id, goal_id, value, source, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, goal_id, value, source, ts);
  updateGoalCurrentValue(goal_id, value);
  return { id, goal_id, value, source, created_at: ts };
}

/**
 * Replace the goal's backfilled history with a fresh set of backdated
 * points (from the agent's date-segmented history query). Never touches
 * live intake/tick/manual snapshots; does not update current_value.
 */
export function replaceBackfillSnapshots(
  goal_id: string,
  points: Array<{ value: number; created_at: string }>,
): number {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO goal_metric_snapshots (id, goal_id, value, source, created_at) VALUES (?, ?, ?, 'backfill', ?)",
  );
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM goal_metric_snapshots WHERE goal_id = ? AND source = 'backfill'",
    ).run(goal_id);
    for (const p of points) insert.run(randomUUID(), goal_id, p.value, p.created_at);
  });
  tx();
  return points.length;
}

export function listMetricSnapshots(goal_id: string, limit = 90): GoalMetricSnapshot[] {
  // Ascending so the sparkline reads left→right; LIMIT applies to the tail.
  return getDb()
    .prepare(
      `SELECT id, goal_id, value, source, created_at FROM (
         SELECT *, rowid AS _rid FROM goal_metric_snapshots
          WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, _rid ASC`,
    )
    .all(goal_id, limit) as GoalMetricSnapshot[];
}

// ── actions ──────────────────────────────────────────────────────────────

export type CreateGoalActionInput = {
  goal_id: string;
  tick_number?: number | null;
  kind: GoalActionKind;
  description: string;
  resources_touched?: string[];
  expected_effect: string;
  review_after?: string | null;
  spend_usd?: number | null;
  /** Agent-written check-diary badge, e.g. "Budget updated". */
  badge?: string | null;
};

export function createGoalAction(input: CreateGoalActionInput): GoalAction {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO goal_actions
       (id, goal_id, tick_number, kind, description, resources_touched_json,
        expected_effect, review_after, spend_usd, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    id,
    input.goal_id,
    input.tick_number ?? null,
    input.kind,
    input.description,
    JSON.stringify(input.resources_touched ?? []),
    input.expected_effect,
    input.review_after ?? null,
    input.spend_usd ?? null,
    ts,
  );
  const badge = input.badge?.trim().slice(0, 60);
  if (badge) {
    db.prepare(
      "INSERT INTO goal_action_badges (action_id, badge, created_at) VALUES (?, ?, ?)",
    ).run(id, badge, ts);
  }
  return getGoalAction(id)!;
}

/** Agent-written badges across a goal's actions, oldest first per tick. */
export function listGoalActionBadges(
  goal_id: string,
): Array<{ tick_number: number | null; badge: string }> {
  return getDb()
    .prepare(
      `SELECT a.tick_number AS tick_number, b.badge AS badge
         FROM goal_action_badges b
         JOIN goal_actions a ON a.id = b.action_id
        WHERE a.goal_id = ?
        ORDER BY a.created_at ASC, a.rowid ASC`,
    )
    .all(goal_id) as Array<{ tick_number: number | null; badge: string }>;
}

export function getGoalAction(id: string): GoalAction | null {
  const row = getDb().prepare("SELECT * FROM goal_actions WHERE id = ?").get(id);
  return (row as GoalAction) ?? null;
}

export function listOpenGoalActions(goal_id: string): GoalAction[] {
  return getDb()
    .prepare(
      "SELECT * FROM goal_actions WHERE goal_id = ? AND status = 'open' ORDER BY created_at ASC, rowid ASC",
    )
    .all(goal_id) as GoalAction[];
}

/** Escalation contract: the agent identity requires decision actions that
 *  need the USER to act to start with this prefix. The "Needs you" UI keys
 *  off it — prose elsewhere never surfaces there. */
export const USER_ACTION_PREFIX = "USER ACTION REQUIRED";

/** Open escalations awaiting the user, oldest first. */
export function listUserActionRequests(goal_id: string): GoalAction[] {
  return listOpenGoalActions(goal_id).filter(
    (a) => a.kind === "decision" && a.description.startsWith(USER_ACTION_PREFIX),
  );
}

/** goal_id → open user-escalation count, for rail badges across a project. */
export function countUserActionRequests(project_slug: string): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT a.goal_id AS goal_id, COUNT(*) AS n
         FROM goal_actions a
         JOIN goals g ON g.id = a.goal_id
        WHERE g.project_slug = ? AND a.status = 'open'
          AND a.kind = 'decision' AND a.description LIKE ? || '%'
        GROUP BY a.goal_id`,
    )
    .all(project_slug, USER_ACTION_PREFIX) as Array<{ goal_id: string; n: number }>;
  return new Map(rows.map((r) => [r.goal_id, r.n]));
}

export function listGoalActions(goal_id: string, limit = 50): GoalAction[] {
  return getDb()
    .prepare(
      "SELECT * FROM goal_actions WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(goal_id, limit) as GoalAction[];
}

/**
 * Close the measurement loop on an action: record what actually happened
 * vs. expected_effect. Only open actions can be reviewed.
 */
export function reviewGoalAction(
  id: string,
  observed_outcome: string,
  status: Extract<GoalActionStatus, "reviewed" | "abandoned"> = "reviewed",
): GoalAction | null {
  const r = getDb()
    .prepare(
      `UPDATE goal_actions
          SET status = ?, observed_outcome = ?, reviewed_at = ?
        WHERE id = ? AND status = 'open'`,
    )
    .run(status, observed_outcome, now(), id);
  if (r.changes === 0) return null;
  return getGoalAction(id);
}

/** Open mutations past their review_after — the "score these first" list. */
export function listActionsDueForReview(goal_id: string, nowIso = now()): GoalAction[] {
  return getDb()
    .prepare(
      `SELECT * FROM goal_actions
        WHERE goal_id = ? AND status = 'open'
          AND review_after IS NOT NULL AND review_after <= ?
        ORDER BY review_after ASC`,
    )
    .all(goal_id, nowIso) as GoalAction[];
}

/**
 * End an action's observation window NOW — the user's manual unlock.
 * The action stays open and becomes immediately due for review, so the
 * agent scores it on its next check; nothing is deleted or rewritten.
 */
export function endActionObservation(id: string): GoalAction | null {
  const ts = now();
  const r = getDb()
    .prepare(
      `UPDATE goal_actions SET review_after = ?
        WHERE id = ? AND status = 'open'
          AND review_after IS NOT NULL AND review_after > ?`,
    )
    .run(ts, id, ts);
  if (r.changes === 0) return null;
  return getGoalAction(id);
}

/** Open mutations still inside their observation window — the gate. */
export function listGatedActions(goal_id: string, nowIso = now()): GoalAction[] {
  return getDb()
    .prepare(
      `SELECT * FROM goal_actions
        WHERE goal_id = ? AND status = 'open'
          AND review_after IS NOT NULL AND review_after > ?
        ORDER BY review_after ASC`,
    )
    .all(goal_id, nowIso) as GoalAction[];
}

// ── learnings ────────────────────────────────────────────────────────────

export function addGoalLearning(
  goal_id: string,
  body: string,
  confidence: GoalLearning["confidence"] = "medium",
  supersedes_id?: string | null,
): GoalLearning {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.prepare(
    "INSERT INTO goal_learnings (id, goal_id, body, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, goal_id, body, confidence, ts);
  if (supersedes_id) {
    db.prepare("UPDATE goal_learnings SET superseded_by = ? WHERE id = ? AND goal_id = ?").run(
      id,
      supersedes_id,
      goal_id,
    );
  }
  return { id, goal_id, body, confidence, superseded_by: null, created_at: ts };
}

/** Most recent non-superseded learnings, newest first. */
export function listGoalLearnings(goal_id: string, limit = 20): GoalLearning[] {
  return getDb()
    .prepare(
      `SELECT * FROM goal_learnings
        WHERE goal_id = ? AND superseded_by IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(goal_id, limit) as GoalLearning[];
}

/** Simple substring search over non-superseded learnings. */
export function searchGoalLearnings(
  goal_id: string,
  query: string,
  limit = 20,
): GoalLearning[] {
  return getDb()
    .prepare(
      `SELECT * FROM goal_learnings
        WHERE goal_id = ? AND superseded_by IS NULL
          AND body LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(
      goal_id,
      `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      limit,
    ) as GoalLearning[];
}

// ── ticks (the diary) ────────────────────────────────────────────────────

export function createGoalTick(input: {
  goal_id: string;
  tick_number: number;
  trigger_kind: GoalTickTrigger;
}): GoalTick {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO goal_ticks
       (id, goal_id, tick_number, trigger_kind, owner_pid, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(id, input.goal_id, input.tick_number, input.trigger_kind, process.pid, ts);
  return getGoalTick(id)!;
}

/** Backfill the measured metric onto a check created before measurement. */
export function setGoalTickMetric(
  id: string,
  metric_value: number | null,
  metric_error: string | null,
): void {
  getDb()
    .prepare("UPDATE goal_ticks SET metric_value = ?, metric_error = ? WHERE id = ?")
    .run(metric_value, metric_error, id);
}

export function getGoalTick(id: string): GoalTick | null {
  const row = getDb().prepare("SELECT * FROM goal_ticks WHERE id = ?").get(id);
  return (row as GoalTick) ?? null;
}

export function attachTickSession(id: string, session_id: string): void {
  getDb().prepare("UPDATE goal_ticks SET session_id = ? WHERE id = ?").run(session_id, id);
}

export function finishGoalTick(
  id: string,
  status: Extract<GoalTickStatus, "done" | "failed">,
  summary?: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE goal_ticks SET status = ?, summary = ?, finished_at = ? WHERE id = ?",
    )
    .run(status, summary ?? null, now(), id);
}

/** Terminal transition used by crash recovery; never overwrite live progress. */
export function finishRunningGoalTick(
  id: string,
  status: Extract<GoalTickStatus, "done" | "failed">,
  summary?: string | null,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE goal_ticks
          SET status = ?, summary = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(status, summary ?? null, now(), id);
  return result.changes === 1;
}

export function listGoalTicks(
  goal_id: string,
  limit = 30,
  /** Cursor: only ticks strictly older than this tick_number (pagination). */
  beforeTick?: number,
): GoalTick[] {
  if (beforeTick !== undefined) {
    return getDb()
      .prepare(
        "SELECT * FROM goal_ticks WHERE goal_id = ? AND tick_number < ? ORDER BY tick_number DESC LIMIT ?",
      )
      .all(goal_id, beforeTick, limit) as GoalTick[];
  }
  return getDb()
    .prepare(
      "SELECT * FROM goal_ticks WHERE goal_id = ? ORDER BY tick_number DESC LIMIT ?",
    )
    .all(goal_id, limit) as GoalTick[];
}

/** Every MCP/tool call started across a goal's tick sessions, in event
 *  order — the checks list classifies these into write badges. */
export function listTickToolCalls(
  goal_id: string,
): Array<{ tick_number: number; name: string }> {
  return getDb()
    .prepare(
      `SELECT t.tick_number AS tick_number,
              json_extract(e.payload_json, '$.name') AS name
         FROM goal_ticks t
         JOIN transcript_events e ON e.session_id = t.session_id
        WHERE t.goal_id = ? AND e.kind = 'tool'
          AND json_extract(e.payload_json, '$.phase') = 'start'
        ORDER BY t.tick_number ASC, e.seq ASC`,
    )
    .all(goal_id) as Array<{ tick_number: number; name: string }>;
}

/** Specific ticks by number, newest first — backs the filtered checks list. */
export function listGoalTicksByNumbers(
  goal_id: string,
  tickNumbers: number[],
): GoalTick[] {
  if (tickNumbers.length === 0) return [];
  const placeholders = tickNumbers.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM goal_ticks WHERE goal_id = ? AND tick_number IN (${placeholders})
        ORDER BY tick_number DESC`,
    )
    .all(goal_id, ...tickNumbers) as GoalTick[];
}

/**
 * Most recent finished tick that carries context worth briefing the next
 * turn with: agent turns (session attached) and failures. Observe-only
 * no-op checks (done, no session) are skipped — a week of "no-op check"
 * rows must not evict the agent's last real summary from the brief.
 */
export function getLastAgentTick(goal_id: string): GoalTick | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM goal_ticks
        WHERE goal_id = ? AND status IN ('done','failed')
          AND NOT (status = 'done' AND session_id IS NULL)
        ORDER BY tick_number DESC LIMIT 1`,
    )
    .get(goal_id);
  return (row as GoalTick) ?? null;
}

// ── derived reads ────────────────────────────────────────────────────────

/**
 * Direction-aware "has the metric met the target?". Null when the goal
 * doesn't have both a target and a current reading yet.
 */
export function isTargetMet(goal: Goal): boolean | null {
  if (goal.target_value === null || goal.current_value === null) return null;
  if (goal.metric_direction === "decrease") {
    return goal.current_value <= goal.target_value;
  }
  return goal.current_value >= goal.target_value;
}

export function isPastDeadline(goal: Goal, nowIso = now()): boolean {
  if (!goal.deadline) return false;
  return nowIso >= goal.deadline;
}

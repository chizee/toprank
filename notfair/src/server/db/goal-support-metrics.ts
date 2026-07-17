import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { MetricDirection } from "./goals";

/**
 * Supporting metrics — extra numbers the loop measures alongside the
 * goal's primary metric. A goal is judged on ONE number (target,
 * deadline, achieved/failed); supporting metrics are the leading
 * indicators and diagnostics around it ("PRs opened" while merges are
 * the target, "impressions" while clicks are the target). Same trust
 * rule as the primary: the agent authors the source once, the platform
 * measures it on every check.
 */

export type GoalSupportMetric = {
  id: string;
  goal_id: string;
  name: string;
  source_key: string;
  source_tool: string;
  source_args_json: string;
  direction: MetricDirection | null;
  baseline_value: number;
  current_value: number;
  created_at: string;
  updated_at: string;
};

export type GoalSupportMetricSnapshot = {
  id: string;
  metric_id: string;
  value: number;
  source: "verify" | "tick" | "backfill";
  created_at: string;
};

function now(): string {
  return new Date().toISOString();
}

export type UpsertSupportMetricInput = {
  goal_id: string;
  name: string;
  source_key: string;
  source_tool: string;
  source_args_json: string;
  direction?: MetricDirection | null;
  /** The value the platform just measured while verifying the source. */
  measured_value: number;
};

/**
 * Add a supporting metric, or redefine it by name (fixing a wrong query
 * shouldn't need a second tool). Redefinition resets baseline + current
 * to the freshly measured value; snapshot history is kept — the chart
 * shows the metric's life, not just its latest definition.
 */
export function upsertSupportMetric(input: UpsertSupportMetricInput): GoalSupportMetric {
  const db = getDb();
  const ts = now();
  db.prepare(
    `INSERT INTO goal_support_metrics
       (id, goal_id, name, source_key, source_tool, source_args_json,
        direction, baseline_value, current_value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(goal_id, name) DO UPDATE SET
       source_key = excluded.source_key,
       source_tool = excluded.source_tool,
       source_args_json = excluded.source_args_json,
       direction = excluded.direction,
       baseline_value = excluded.baseline_value,
       current_value = excluded.current_value,
       updated_at = excluded.updated_at`,
  ).run(
    randomUUID(),
    input.goal_id,
    input.name,
    input.source_key,
    input.source_tool,
    input.source_args_json,
    input.direction ?? null,
    input.measured_value,
    input.measured_value,
    ts,
    ts,
  );
  const metric = getSupportMetricByName(input.goal_id, input.name)!;
  recordSupportMetricSnapshot(metric.id, input.measured_value, "verify");
  return metric;
}

export function getSupportMetricByName(
  goal_id: string,
  name: string,
): GoalSupportMetric | null {
  const row = getDb()
    .prepare("SELECT * FROM goal_support_metrics WHERE goal_id = ? AND name = ?")
    .get(goal_id, name);
  return (row as GoalSupportMetric) ?? null;
}

export function listSupportMetrics(goal_id: string): GoalSupportMetric[] {
  return getDb()
    .prepare(
      "SELECT * FROM goal_support_metrics WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(goal_id) as GoalSupportMetric[];
}

export function recordSupportMetricSnapshot(
  metric_id: string,
  value: number,
  source: GoalSupportMetricSnapshot["source"] = "tick",
): GoalSupportMetricSnapshot {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.prepare(
    "INSERT INTO goal_support_metric_snapshots (id, metric_id, value, source, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, metric_id, value, source, ts);
  db.prepare(
    "UPDATE goal_support_metrics SET current_value = ?, updated_at = ? WHERE id = ?",
  ).run(value, ts, metric_id);
  return { id, metric_id, value, source, created_at: ts };
}

/**
 * Replace the metric's backfilled history with fresh backdated points —
 * same contract as the primary's replaceBackfillSnapshots: live
 * verify/tick snapshots are untouched, and current_value is not updated.
 */
export function replaceSupportBackfillSnapshots(
  metric_id: string,
  points: Array<{ value: number; created_at: string }>,
): number {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO goal_support_metric_snapshots (id, metric_id, value, source, created_at) VALUES (?, ?, ?, 'backfill', ?)",
  );
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM goal_support_metric_snapshots WHERE metric_id = ? AND source = 'backfill'",
    ).run(metric_id);
    for (const p of points) insert.run(randomUUID(), metric_id, p.value, p.created_at);
  });
  tx();
  return points.length;
}

export function listSupportMetricSnapshots(
  metric_id: string,
  limit = 90,
): GoalSupportMetricSnapshot[] {
  // Ascending so sparklines read left→right; LIMIT applies to the tail.
  return getDb()
    .prepare(
      `SELECT id, metric_id, value, source, created_at FROM (
         SELECT *, rowid AS _rid FROM goal_support_metric_snapshots
          WHERE metric_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, _rid ASC`,
    )
    .all(metric_id, limit) as GoalSupportMetricSnapshot[];
}

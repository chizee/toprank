import { beforeAll, describe, expect, it, vi } from "vitest";

// Real better-sqlite3 against a tmpdir DB, per repo test conventions.
// MUST be hoisted: static imports evaluate before module-level statements,
// and db.ts captures NOTFAIR_DATA_DIR at import time — a plain assignment
// here would silently point the suite at the developer's live ~/.notfair.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-support-"));
});

import { getDb } from "./db";
import { createGoal } from "./goals";
import {
  listSupportMetricSnapshots,
  listSupportMetrics,
  recordSupportMetricSnapshot,
  replaceSupportBackfillSnapshots,
  upsertSupportMetric,
} from "./goal-support-metrics";
import { handleAddSupportMetric } from "@/server/goals/handlers";

const SLUG = "proj";
let goalId: string;

beforeAll(() => {
  getDb()
    .prepare(
      "INSERT INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES ('p1', ?, 'Proj', ?, 'codex-local')",
    )
    .run(SLUG, new Date().toISOString());
  goalId = createGoal({ project_slug: SLUG, agent_id: "agent-1", statement: "ship" }).id;
});

describe("goal-support-metrics db", () => {
  it("inserts, lists, and snapshots on upsert", () => {
    const m = upsertSupportMetric({
      goal_id: goalId,
      name: "PRs opened",
      source_key: "local",
      source_tool: "shell",
      source_args_json: `{"command":"echo 5"}`,
      direction: "increase",
      measured_value: 5,
    });
    expect(m.baseline_value).toBe(5);
    expect(m.current_value).toBe(5);
    expect(listSupportMetrics(goalId)).toHaveLength(1);
    const snaps = listSupportMetricSnapshots(m.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.source).toBe("verify");
  });

  it("re-using the name redefines in place and keeps snapshot history", () => {
    const before = listSupportMetrics(goalId)[0]!;
    const m = upsertSupportMetric({
      goal_id: goalId,
      name: "PRs opened",
      source_key: "local",
      source_tool: "shell",
      source_args_json: `{"command":"echo 8"}`,
      measured_value: 8,
    });
    expect(m.id).toBe(before.id); // same row, not a duplicate
    expect(m.baseline_value).toBe(8);
    expect(m.direction).toBeNull(); // redefinition replaces the spec
    expect(listSupportMetrics(goalId)).toHaveLength(1);
    expect(listSupportMetricSnapshots(m.id).length).toBe(2);
  });

  it("tick snapshots advance current_value", () => {
    const m = listSupportMetrics(goalId)[0]!;
    recordSupportMetricSnapshot(m.id, 11, "tick");
    expect(listSupportMetrics(goalId)[0]!.current_value).toBe(11);
  });

  it("backfill replaces prior backfill, keeps live snapshots and current_value", () => {
    const m = listSupportMetrics(goalId)[0]!;
    const liveBefore = listSupportMetricSnapshots(m.id).filter(
      (s) => s.source !== "backfill",
    ).length;
    replaceSupportBackfillSnapshots(m.id, [
      { value: 1, created_at: "2026-07-01T00:00:00.000Z" },
      { value: 2, created_at: "2026-07-02T00:00:00.000Z" },
    ]);
    replaceSupportBackfillSnapshots(m.id, [
      { value: 3, created_at: "2026-07-03T00:00:00.000Z" },
    ]);
    const snaps = listSupportMetricSnapshots(m.id);
    expect(snaps.filter((s) => s.source === "backfill")).toHaveLength(1);
    expect(snaps.filter((s) => s.source !== "backfill")).toHaveLength(liveBefore);
    expect(listSupportMetrics(goalId)[0]!.current_value).toBe(11); // untouched
  });
});

describe("handleAddSupportMetric", () => {
  const ctx = { project_slug: SLUG, agent_id: "agent-1" };

  it("verifies through the local source and stores the metric", async () => {
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "Open listing PRs (live)",
        source_key: "local",
        source_tool: "shell",
        source_args_json: `{"command":"echo 104"}`,
        direction: "increase",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.metric.current_value).toBe(104);
  });

  it("backfills history when history_args_json is given", async () => {
    const history = JSON.stringify({
      command: `echo '[{"date":"2026-07-01","value":100},{"date":"2026-07-02","value":102}]'`,
    });
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "Open listing PRs (live)",
        source_key: "local",
        source_tool: "shell",
        source_args_json: `{"command":"echo 104"}`,
        history_args_json: history,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.backfilled).toBe(2);
  });

  it("fails with a fix-and-retry error when the history query is broken", async () => {
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "Open listing PRs (live)",
        source_key: "local",
        source_tool: "shell",
        source_args_json: `{"command":"echo 104"}`,
        history_args_json: `{"command":"echo not-an-array"}`,
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("history query failed");
  });

  it("rejects a failing source with the measurement error", async () => {
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "Broken",
        source_key: "local",
        source_tool: "shell",
        source_args_json: `{"command":"echo nope"}`,
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("verification failed");
  });

  it("rejects an unconnected MCP source key", async () => {
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "Clicks",
        source_key: "notfair-googlesearchconsole",
        source_tool: "runScript",
        source_args_json: `{}`,
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("No connected MCP");
  });

  it("rejects another agent's goal", async () => {
    const r = await handleAddSupportMetric(
      {
        goal_id: goalId,
        name: "X",
        source_key: "local",
        source_tool: "shell",
        source_args_json: `{"command":"echo 1"}`,
      },
      { project_slug: SLUG, agent_id: "agent-2" },
    );
    expect(r.ok).toBe(false);
  });
});

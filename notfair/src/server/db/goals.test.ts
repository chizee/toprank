import { beforeAll, describe, expect, it, vi } from "vitest";

// Real better-sqlite3 against a tmpdir DB, per repo test conventions.
// MUST be hoisted: static imports evaluate before module-level statements,
// and db.ts captures NOTFAIR_DATA_DIR at import time — a plain assignment
// here would silently point the suite at the developer's live ~/.notfair.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-goals-"));
});

import { getDb } from "./db";
import {
  createGoal,
  createGoalAction,
  deleteGoalsForAgent,
  endActionObservation,
  getGoal,
  getPinnedGoalIds,
  listGatedActions,
  recordMetricSnapshot,
  renameGoal,
  setGoalPinned,
} from "./goals";

const SLUG = "proj";

beforeAll(() => {
  getDb()
    .prepare(
      "INSERT INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES ('p1', ?, 'Proj', ?, 'codex-local')",
    )
    .run(SLUG, new Date().toISOString());
});

describe("renameGoal", () => {
  it("updates short_label and returns the goal", () => {
    const goal = createGoal({ project_slug: SLUG, agent_id: "a-rename", statement: "ship" });
    const renamed = renameGoal(goal.id, "Ship it → 100%");
    expect(renamed?.short_label).toBe("Ship it → 100%");
  });

  it("returns null for an unknown goal", () => {
    expect(renameGoal("nope", "x")).toBeNull();
  });
});

describe("goal pins", () => {
  it("pin/unpin round-trips and is idempotent", () => {
    const goal = createGoal({ project_slug: SLUG, agent_id: "a-pin", statement: "pin me" });
    setGoalPinned(goal.id, true);
    setGoalPinned(goal.id, true); // no throw on double-pin
    expect(getPinnedGoalIds(SLUG).has(goal.id)).toBe(true);
    setGoalPinned(goal.id, false);
    expect(getPinnedGoalIds(SLUG).has(goal.id)).toBe(false);
  });

  it("scopes pinned ids to the project", () => {
    getDb()
      .prepare(
        "INSERT INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES ('p2', 'other', 'Other', ?, 'codex-local')",
      )
      .run(new Date().toISOString());
    const goal = createGoal({ project_slug: "other", agent_id: "a-other", statement: "x" });
    setGoalPinned(goal.id, true);
    expect(getPinnedGoalIds(SLUG).has(goal.id)).toBe(false);
    expect(getPinnedGoalIds("other").has(goal.id)).toBe(true);
  });
});

describe("endActionObservation", () => {
  it("releases a gated action into review-due without touching its status", () => {
    const goal = createGoal({ project_slug: SLUG, agent_id: "a-unlock", statement: "x" });
    const action = createGoalAction({
      goal_id: goal.id,
      kind: "mutation",
      description: "gated",
      expected_effect: "n/a",
      review_after: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(listGatedActions(goal.id)).toHaveLength(1);

    const released = endActionObservation(action.id);
    expect(released?.status).toBe("open");
    expect(listGatedActions(goal.id)).toHaveLength(0);
    // Releasing twice (or releasing a windowless action) is a no-op.
    expect(endActionObservation(action.id)).toBeNull();
  });
});

describe("deleteGoalsForAgent", () => {
  it("deletes the goal rows and cascades child tables", () => {
    const goal = createGoal({ project_slug: SLUG, agent_id: "a-del", statement: "delete me" });
    recordMetricSnapshot(goal.id, 42, "intake");
    setGoalPinned(goal.id, true);

    expect(deleteGoalsForAgent("a-del")).toBe(1);
    expect(getGoal(goal.id)).toBeNull();
    const snaps = getDb()
      .prepare("SELECT COUNT(*) AS n FROM goal_metric_snapshots WHERE goal_id = ?")
      .get(goal.id) as { n: number };
    expect(snaps.n).toBe(0);
    const pins = getDb()
      .prepare("SELECT COUNT(*) AS n FROM goal_pins WHERE goal_id = ?")
      .get(goal.id) as { n: number };
    expect(pins.n).toBe(0);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real better-sqlite3 against a tmpdir DB, per repo test conventions.
// MUST be hoisted: static imports evaluate before module-level statements,
// and db.ts captures NOTFAIR_DATA_DIR at import time — a plain assignment
// here would silently point the suite at the developer's live ~/.notfair.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-checks-"));
});

import { CHECKS_PAGE_SIZE, listCheckRows } from "./checks";
import { getDb } from "@/server/db/db";
import {
  createGoal,
  createGoalAction,
  createGoalTick,
} from "@/server/db/goals";
import { createGoalPr } from "@/server/db/goal-prs";

const SLUG = "proj";
let goalId: string;

beforeAll(() => {
  getDb()
    .prepare(
      "INSERT INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES ('p1', ?, 'Proj', ?, 'codex-local')",
    )
    .run(SLUG, new Date().toISOString());
  goalId = createGoal({
    project_slug: SLUG,
    agent_id: "agent-1",
    statement: "Grow organic clicks",
  }).id;
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM goal_ticks").run();
  db.prepare("DELETE FROM goal_prs").run();
  db.prepare("DELETE FROM goal_actions").run();
});

function seedTicks(count: number): void {
  for (let n = 1; n <= count; n++) {
    createGoalTick({ goal_id: goalId, tick_number: n, trigger_kind: "heartbeat" });
  }
}

describe("listCheckRows paging", () => {
  it("returns the newest page with hasMore when older checks exist", () => {
    seedTicks(CHECKS_PAGE_SIZE + 2);
    const { rows, hasMore } = listCheckRows(goalId);
    expect(rows).toHaveLength(CHECKS_PAGE_SIZE);
    expect(rows[0]!.tick_number).toBe(CHECKS_PAGE_SIZE + 2);
    expect(rows.at(-1)!.tick_number).toBe(3);
    expect(hasMore).toBe(true);
  });

  it("reports no more pages when everything fits", () => {
    seedTicks(4);
    const { rows, hasMore } = listCheckRows(goalId);
    expect(rows.map((r) => r.tick_number)).toEqual([4, 3, 2, 1]);
    expect(hasMore).toBe(false);
  });

  it("pages strictly older than the cursor, newest first", () => {
    seedTicks(CHECKS_PAGE_SIZE + 2);
    const { rows, hasMore } = listCheckRows(goalId, { beforeTick: 3 });
    expect(rows.map((r) => r.tick_number)).toEqual([2, 1]);
    expect(hasMore).toBe(false);
  });
});

describe("listCheckRows action filter", () => {
  it("annotates every row with its action count", () => {
    seedTicks(3);
    createGoalAction({
      goal_id: goalId,
      tick_number: 2,
      kind: "mutation",
      description: "Pause wasted keywords",
      expected_effect: "less waste",
      review_after: null,
    });
    createGoalAction({
      goal_id: goalId,
      tick_number: 2,
      kind: "research",
      description: "Read search terms",
      expected_effect: "context",
      review_after: null,
    });
    const { rows } = listCheckRows(goalId);
    expect(rows.map((r) => [r.tick_number, r.actions_count])).toEqual([
      [3, 0],
      [2, 2],
      [1, 0],
    ]);
  });

  it("filter=action keeps only checks with actions or PRs, cursor-paged", () => {
    seedTicks(6);
    createGoalAction({
      goal_id: goalId,
      tick_number: 5,
      kind: "mutation",
      description: "Raise budget",
      expected_effect: "more clicks",
      review_after: null,
    });
    createGoalAction({
      goal_id: goalId,
      tick_number: 2,
      kind: "decision",
      description: "Hold steady",
      expected_effect: "n/a",
      review_after: null,
    });
    createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/7",
      title: "Fix titles",
      tick_number: 4,
    });

    const first = listCheckRows(goalId, { filter: "action", limit: 2 });
    expect(first.rows.map((r) => r.tick_number)).toEqual([5, 4]);
    expect(first.hasMore).toBe(true);

    const next = listCheckRows(goalId, { filter: "action", limit: 2, beforeTick: 4 });
    expect(next.rows.map((r) => r.tick_number)).toEqual([2]);
    expect(next.hasMore).toBe(false);
  });
});

describe("listCheckRows PR attachment", () => {
  it("attaches a PR to the check stamped on it at registration", () => {
    seedTicks(3);
    createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/7",
      title: "Fix titles",
      tick_number: 2,
    });
    const { rows } = listCheckRows(goalId);
    const byTick = new Map(rows.map((r) => [r.tick_number, r.prs]));
    expect(byTick.get(2)).toEqual([
      expect.objectContaining({ url: "https://github.com/acme/site/pull/7", state: "open" }),
    ]);
    expect(byTick.get(1)).toEqual([]);
    expect(byTick.get(3)).toEqual([]);
  });

  it("falls back to the linked action's check for pre-stamping PRs", () => {
    seedTicks(3);
    const action = createGoalAction({
      goal_id: goalId,
      tick_number: 3,
      kind: "mutation",
      description: "Pause wasted keywords",
      expected_effect: "less waste",
      review_after: null,
    });
    createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/8",
      title: "Legacy PR",
      action_id: action.id,
      // No tick_number: registered before stamping existed.
    });
    const { rows } = listCheckRows(goalId);
    expect(rows.find((r) => r.tick_number === 3)!.prs).toEqual([
      expect.objectContaining({ url: "https://github.com/acme/site/pull/8" }),
    ]);
  });

  it("leaves PRs with neither stamp nor action off every check", () => {
    seedTicks(2);
    createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/9",
      title: "Orphan",
    });
    const { rows } = listCheckRows(goalId);
    expect(rows.every((r) => r.prs.length === 0)).toBe(true);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real better-sqlite3 against a tmpdir DB, per repo test conventions.
// MUST be hoisted: static imports evaluate before module-level statements,
// and db.ts captures NOTFAIR_DATA_DIR at import time — a plain assignment
// here would silently point the suite at the developer's live ~/.notfair.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-prs-"));
});

import {
  applyGoalPrSync,
  createGoalPr,
  findGoalPrByUrl,
  listDuePrSyncs,
  listGoalPrs,
  listOpenGoalPrs,
  listPrsAwaitingReview,
  markGoalPrSyncError,
} from "@/server/db/goal-prs";
import { getDb } from "@/server/db/db";
import { createGoal } from "@/server/db/goals";

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
  getDb().prepare("DELETE FROM goal_prs").run();
  vi.restoreAllMocks();
});

const URL1 = "https://github.com/acme/site/pull/12";

describe("goal_prs data layer", () => {
  it("creates a PR row in open state and finds it by url", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "Fix titles" });
    expect(pr.state).toBe("open");
    expect(pr.review_decision).toBeNull();
    expect(findGoalPrByUrl(goalId, URL1)?.id).toBe(pr.id);
    expect(listGoalPrs(goalId)).toHaveLength(1);
  });

  it("returns the winning row when the same goal and url are inserted twice", () => {
    const first = createGoalPr({
      goal_id: goalId,
      url: URL1,
      title: "Fix titles",
    });
    const duplicate = createGoalPr({
      goal_id: goalId,
      url: URL1,
      title: "Duplicate registration",
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.title).toBe("Fix titles");
    expect(listGoalPrs(goalId)).toHaveLength(1);
  });

  it("applies a GitHub sync and clears prior sync errors", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    markGoalPrSyncError(pr.id, "gh not found");
    const synced = applyGoalPrSync(pr.id, {
      state: "merged",
      title: "Fix titles",
      review_decision: "APPROVED",
      comment_count: 3,
      is_draft: false,
      merged_at: "2026-07-13T00:00:00Z",
    })!;
    expect(synced.state).toBe("merged");
    expect(synced.title).toBe("Fix titles");
    expect(synced.comment_count).toBe(3);
    expect(synced.sync_error).toBeNull();
    expect(listOpenGoalPrs(goalId)).toHaveLength(0);
  });

  it("awaiting-review covers open non-draft PRs unless changes were requested", () => {
    const a = createGoalPr({ goal_id: goalId, url: URL1, title: "a" });
    const b = createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/13",
      title: "b",
    });
    const c = createGoalPr({
      goal_id: goalId,
      url: "https://github.com/acme/site/pull/14",
      title: "c",
    });
    // a: untouched (never synced) → awaiting review.
    // b: user requested changes → ball is with the agent, not the user.
    applyGoalPrSync(b.id, {
      state: "open",
      review_decision: "CHANGES_REQUESTED",
      comment_count: 2,
      is_draft: false,
      merged_at: null,
    });
    // c: merged → terminal, not awaiting anything.
    applyGoalPrSync(c.id, {
      state: "merged",
      review_decision: "APPROVED",
      comment_count: 0,
      is_draft: false,
      merged_at: "2026-07-13T00:00:00Z",
    });
    const awaiting = listPrsAwaitingReview(SLUG);
    expect(awaiting.map((p) => p.id)).toEqual([a.id]);
  });
});

describe("adaptive sync scheduling", () => {
  it("a fresh registration is immediately due", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    expect(pr.next_sync_at).not.toBeNull();
    expect(pr.last_activity_at).not.toBeNull();
    expect(listDuePrSyncs().map((p) => p.id)).toContain(pr.id);
  });

  it("an observed change resets activity and schedules the fast lane", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    const synced = applyGoalPrSync(pr.id, {
      state: "open",
      review_decision: "CHANGES_REQUESTED",
      comment_count: 2,
      is_draft: false,
      merged_at: null,
    })!;
    expect(synced.last_activity_at).not.toBeNull();
    // Fast lane: ~2 minutes out — definitely not due now, well within 3 min.
    const dueIn = Date.parse(synced.next_sync_at!) - Date.now();
    expect(dueIn).toBeGreaterThan(60_000);
    expect(dueIn).toBeLessThan(3 * 60_000);
    expect(listDuePrSyncs().map((p) => p.id)).not.toContain(pr.id);
  });

  it("a no-change sync keeps the old activity timestamp (backoff grows)", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    const payload = {
      state: "open" as const,
      review_decision: "",
      comment_count: 0,
      is_draft: false,
      merged_at: null,
    };
    const first = applyGoalPrSync(pr.id, payload)!; // change (decision null → "")
    const second = applyGoalPrSync(pr.id, payload)!; // no change
    expect(second.last_activity_at).toBe(first.last_activity_at);
  });

  it("terminal PRs leave the schedule entirely", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    const merged = applyGoalPrSync(pr.id, {
      state: "merged",
      review_decision: "APPROVED",
      comment_count: 0,
      is_draft: false,
      merged_at: "2026-07-13T00:00:00Z",
    })!;
    expect(merged.next_sync_at).toBeNull();
    expect(listDuePrSyncs().map((p) => p.id)).not.toContain(pr.id);
  });

  it("a failed sync retries on the error delay instead of going dark", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    markGoalPrSyncError(pr.id, "gh: command not found");
    const row = findGoalPrByUrl(goalId, URL1)!;
    const dueIn = Date.parse(row.next_sync_at!) - Date.now();
    expect(dueIn).toBeGreaterThan(4 * 60_000);
    expect(dueIn).toBeLessThan(6 * 60_000);
  });

  it("open rows with NULL next_sync_at (pre-policy data) self-heal as due", () => {
    const pr = createGoalPr({ goal_id: goalId, url: URL1, title: "t" });
    getDb()
      .prepare("UPDATE goal_prs SET next_sync_at = NULL WHERE id = ?")
      .run(pr.id);
    expect(listDuePrSyncs().map((p) => p.id)).toContain(pr.id);
  });
});

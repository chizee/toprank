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

import { CHECKS_PAGE_SIZE, listCheckRows, writeBadgeForTool } from "./checks";
import { getDb } from "@/server/db/db";
import {
  attachTickSession,
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
  db.prepare("DELETE FROM transcript_events").run();
  db.prepare("DELETE FROM sessions").run();
});

function seedTicks(count: number): void {
  for (let n = 1; n <= count; n++) {
    createGoalTick({ goal_id: goalId, tick_number: n, trigger_kind: "heartbeat" });
  }
}

/** Attach a session to a tick and record tool-call start events in it. */
function seedTickToolCalls(tick_number: number, toolNames: string[]): void {
  const db = getDb();
  const ts = new Date().toISOString();
  const sessionId = `s-tick-${tick_number}`;
  db.prepare(
    `INSERT INTO sessions (id, project_slug, agent_id, label, harness_adapter, created_at, updated_at)
     VALUES (?, ?, 'agent-1', ?, 'codex-local', ?, ?)`,
  ).run(sessionId, SLUG, `tick-${tick_number}`, ts, ts);
  const tickId = db
    .prepare("SELECT id FROM goal_ticks WHERE goal_id = ? AND tick_number = ?")
    .get(goalId, tick_number) as { id: string };
  attachTickSession(tickId.id, sessionId);
  toolNames.forEach((name, i) => {
    db.prepare(
      `INSERT INTO transcript_events (id, session_id, seq, kind, payload_json, created_at)
       VALUES (?, ?, ?, 'tool', ?, ?)`,
    ).run(
      `${sessionId}-e${i}`,
      sessionId,
      i + 1,
      JSON.stringify({ kind: "tool", phase: "start", toolCallId: `item_${i}`, name }),
      ts,
    );
  });
}

describe("listCheckRows paging", () => {
  it("records the process that owns a running tick", () => {
    seedTicks(1);
    const row = getDb()
      .prepare("SELECT owner_pid FROM goal_ticks WHERE goal_id = ?")
      .get(goalId) as { owner_pid: number };
    expect(row.owner_pid).toBe(process.pid);
  });

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

describe("writeBadgeForTool", () => {
  it("maps write tool calls to short badge labels", () => {
    expect(
      writeBadgeForTool("notfair_x__notfair_googleads.updateCampaignBudget"),
    ).toBe("Campaign budget updated");
    expect(writeBadgeForTool("mcp__NotFair-GoogleAds__pauseKeyword")).toBe(
      "Keyword paused",
    );
    expect(writeBadgeForTool("notfair_x__notfair_goals.amend_goal")).toBe(
      "Goal updated",
    );
    expect(writeBadgeForTool("notfair_x__notfair_goals.add_supporting_metric")).toBe(
      "Supporting metric added",
    );
    expect(writeBadgeForTool("mcp__NotFair-GoogleAds__bulkAddKeywords")).toBe(
      "Keywords added",
    );
    expect(writeBadgeForTool("mcp__NotFair-GoogleAds__runMutationScript")).toBe(
      "Mutation script ran",
    );
    // Bare-verb and prepositional third-party tools stay grammatical.
    expect(writeBadgeForTool("mcp__NotFair-GoogleAds__mutate")).toBe("Mutated");
    expect(writeBadgeForTool("mcp__vercel__deploy_to_vercel")).toBe(
      "Deployed to vercel",
    );
    expect(writeBadgeForTool("mcp__slack__send_message")).toBe("Message sent");
  });

  it("ignores reads, diary bookkeeping, harness built-ins, and PR tools", () => {
    expect(writeBadgeForTool("shell")).toBeNull();
    expect(writeBadgeForTool("Write")).toBeNull(); // workspace file, not a platform write
    expect(writeBadgeForTool("Edit")).toBeNull();
    expect(writeBadgeForTool("notfair_x__posthog.exec")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_googleads.listKeywords")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_goals.get_goal")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_goals.log_goal_action")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_goals.log_learning")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_goals.review_goal_action")).toBeNull();
    expect(
      writeBadgeForTool("notfair_x__notfair_goals.register_pull_request"),
    ).toBeNull();
    expect(writeBadgeForTool("codex_apps.github.create_pull_request")).toBeNull();
    expect(writeBadgeForTool("notfair_x__notfair_xads.runScript")).toBeNull();
  });
});

describe("listCheckRows write badges + action filter", () => {
  it("dedupes a check's write calls into counted badges; read-only checks get none", () => {
    seedTicks(3);
    seedTickToolCalls(2, [
      "notfair_x__notfair_googleads.updateCampaignBudget",
      "notfair_x__notfair_googleads.pauseKeyword",
      "notfair_x__notfair_googleads.pauseKeyword",
      "notfair_x__posthog.exec", // read — no badge
      "shell",
    ]);
    seedTickToolCalls(3, ["notfair_x__posthog.exec", "shell"]);

    const { rows } = listCheckRows(goalId);
    const byTick = new Map(rows.map((r) => [r.tick_number, r.writes]));
    expect(byTick.get(2)).toEqual([
      { label: "Campaign budget updated", count: 1 },
      { label: "Keyword paused", count: 2 },
    ]);
    expect(byTick.get(3)).toEqual([]);
    expect(byTick.get(1)).toEqual([]);
  });

  it("prefers agent-written action badges over name-derived ones for that check", () => {
    seedTicks(2);
    seedTickToolCalls(2, ["notfair_x__notfair_googleads.updateCampaignBudget"]);
    createGoalAction({
      goal_id: goalId,
      tick_number: 2,
      kind: "mutation",
      description: "Raised campaign 123 daily budget $20 → $40",
      expected_effect: "more clicks",
      review_after: null,
      badge: "Budget raised",
    });

    const { rows } = listCheckRows(goalId);
    expect(rows.find((r) => r.tick_number === 2)!.writes).toEqual([
      { label: "Budget raised", count: 1 },
    ]);
  });

  it("drops PR-ish agent badges and falls back to the classifier", () => {
    seedTicks(1);
    seedTickToolCalls(1, ["notfair_x__notfair_goals.amend_goal"]);
    createGoalAction({
      goal_id: goalId,
      tick_number: 1,
      kind: "mutation",
      description: "Opened a code PR",
      expected_effect: "fix lands",
      review_after: null,
      badge: "PR opened", // redundant with the PR pill
    });

    const { rows } = listCheckRows(goalId);
    expect(rows[0]!.writes).toEqual([{ label: "Goal updated", count: 1 }]);
  });

  it("filter=action keeps only checks that wrote or opened a PR, cursor-paged", () => {
    seedTicks(6);
    seedTickToolCalls(5, ["notfair_x__notfair_googleads.updateCampaignBudget"]);
    seedTickToolCalls(3, ["notfair_x__posthog.exec"]); // read-only — excluded
    seedTickToolCalls(2, ["notfair_x__notfair_goals.amend_goal"]);
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

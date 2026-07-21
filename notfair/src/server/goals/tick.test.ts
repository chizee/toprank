import { describe, expect, it } from "vitest";

import { buildTickMessage, decideAgentTurn, type TickContext } from "@/server/goals/tick";
import type { Goal, GoalAction } from "@/server/db/goals";

/** Baseline: the one situation that should NOT wake the agent — an
 *  achieve goal mid-flight with everything inside observation windows. */
const observeOnly = {
  trigger: "heartbeat" as const,
  hasExtraContext: false,
  measurementOk: true,
  mode: "achieve" as const,
  targetMet: false,
  pastDeadline: false,
  actionsDueForReview: 0,
  gatedActions: 1,
  earliestGateEnd: "2026-07-27T21:55:15.995Z",
  openPrs: 0,
};

describe("decideAgentTurn", () => {
  it("skips the agent turn only when there is provably nothing to do", () => {
    const d = decideAgentTurn(observeOnly);
    expect(d.wake).toBe(false);
    if (!d.wake) {
      expect(d.noopSummary).toContain("No-op check");
      expect(d.noopSummary).toContain("2026-07-27");
    }
  });

  it("always wakes on manual / approval triggers and approval context", () => {
    expect(decideAgentTurn({ ...observeOnly, trigger: "manual" }).wake).toBe(true);
    expect(decideAgentTurn({ ...observeOnly, trigger: "approval" }).wake).toBe(true);
    expect(decideAgentTurn({ ...observeOnly, hasExtraContext: true }).wake).toBe(true);
  });

  it("wakes when the measurement failed", () => {
    expect(decideAgentTurn({ ...observeOnly, measurementOk: false }).wake).toBe(true);
  });

  it("wakes when actions are due for review", () => {
    expect(decideAgentTurn({ ...observeOnly, actionsDueForReview: 1 }).wake).toBe(true);
  });

  it("wakes while any PR is open", () => {
    expect(decideAgentTurn({ ...observeOnly, openPrs: 1 }).wake).toBe(true);
  });

  it("wakes on stop conditions: deadline passed or achieve-target met", () => {
    expect(decideAgentTurn({ ...observeOnly, pastDeadline: true }).wake).toBe(true);
    expect(decideAgentTurn({ ...observeOnly, targetMet: true }).wake).toBe(true);
    // Unknown target state is never grounds to skip.
    expect(decideAgentTurn({ ...observeOnly, targetMet: null }).wake).toBe(true);
  });

  it("maintain goals observe while holding, wake on drift", () => {
    const maintain = { ...observeOnly, mode: "maintain" as const };
    expect(decideAgentTurn({ ...maintain, targetMet: true }).wake).toBe(false);
    expect(decideAgentTurn({ ...maintain, targetMet: false }).wake).toBe(true);
    expect(decideAgentTurn({ ...maintain, targetMet: null }).wake).toBe(true);
  });

  it("wakes when no observation window is open — the agent has a free hand", () => {
    expect(
      decideAgentTurn({ ...observeOnly, gatedActions: 0, earliestGateEnd: null }).wake,
    ).toBe(true);
  });
});

/** Minimal brief context: an achieve goal mid-flight with nothing pending. */
const briefCtx: TickContext = {
  goal: {
    metric_name: "fixable-error rate",
    baseline_value: 10,
    target_value: 1,
    metric_direction: "down",
    mode: "achieve",
    deadline: null,
    spend_envelope_usd: null,
  } as unknown as Goal,
  tickNumber: 92,
  nowIso: "2026-07-21T00:00:00.000Z",
  measurement: { ok: true, value: 3 },
  supportReadings: [],
  targetMet: false,
  pastDeadline: false,
  actionsDueForReview: [],
  gatedActions: [],
  gatedByOthers: [],
  userActionRequests: [],
  loggedSpendUsd: 0,
  recentLearnings: [],
  lastTick: null,
  pullRequests: [],
};

describe("buildTickMessage — Needs you section", () => {
  it("mirrors the open escalations verbatim as the only asks to repeat", () => {
    const ask = {
      id: "act-1",
      description: "USER ACTION REQUIRED: rotate the PostHog API key",
    } as GoalAction;
    const msg = buildTickMessage({ ...briefCtx, userActionRequests: [ask] });
    expect(msg).toContain("## Needs you");
    expect(msg).toContain("[act-1] USER ACTION REQUIRED: rotate the PostHog API key");
    expect(msg).toContain("only these");
  });

  it("with no open asks, forbids repeating retired ones from memory", () => {
    const msg = buildTickMessage(briefCtx);
    expect(msg).toContain("## Needs you");
    expect(msg).toContain("do NOT repeat any earlier ask");
  });
});

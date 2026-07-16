import { describe, expect, it } from "vitest";

import { decideAgentTurn } from "@/server/goals/tick";

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

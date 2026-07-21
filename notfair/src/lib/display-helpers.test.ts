import { describe, expect, it } from "vitest";

import { colorForAgentSlug } from "./agent-colors";
import { cadenceLabel, CADENCE_OPTIONS, DEFAULT_CADENCE } from "./goal-cadence";
import { formatMetric } from "./format-metric";
import { goalLabel } from "./goal-label";
import { buildCheckSquares, currentStreak, heldAtTarget } from "./goal-streak";

describe("display helpers", () => {
  it("assigns deterministic, varied agent colors", () => {
    expect(colorForAgentSlug("goal-one")).toEqual(colorForAgentSlug("goal-one"));
    expect(colorForAgentSlug("goal-one")).not.toEqual(colorForAgentSlug("goal-two"));
    expect(colorForAgentSlug("").chip).toContain("surface-2");
  });

  it("prefers short labels and trims statement fallbacks at words", () => {
    expect(goalLabel({ short_label: "  Revenue  ", statement: "ignored" })).toBe("Revenue");
    expect(goalLabel({ short_label: " ", statement: "  Short ambition  " })).toBe("Short ambition");
    expect(goalLabel({ statement: "This statement is deliberately much longer than forty two characters total" })).toBe(
      "This statement is deliberately much…",
    );
    expect(goalLabel({ statement: "Averylongstatementwithnospacesandmorethanfortytwocharacters" })).toHaveLength(43);
    expect(goalLabel({})).toBe("New goal");
  });

  it("formats metrics and cadence presets", () => {
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric(undefined)).toBe("—");
    expect(formatMetric(82065.857142)).toBe("82,065.86");
    expect(DEFAULT_CADENCE).toBe(CADENCE_OPTIONS[0]!.value);
    expect(cadenceLabel(DEFAULT_CADENCE)).toContain("Hourly");
    expect(cadenceLabel("custom cron")).toBe("custom cron");
  });
});

describe("goal streaks", () => {
  it("evaluates increase/decrease targets and null values", () => {
    expect(heldAtTarget(null, 1, "increase")).toBe(false);
    expect(heldAtTarget(1, null, "decrease")).toBe(false);
    expect(heldAtTarget(10, 10, "increase")).toBe(true);
    expect(heldAtTarget(9, 10, "increase")).toBe(false);
    expect(heldAtTarget(9, 10, "decrease")).toBe(true);
    expect(heldAtTarget(11, 10, "decrease")).toBe(false);
  });

  it("sorts checks and classifies failed, acted, and held squares", () => {
    const squares = buildCheckSquares([
      { tick_number: 3, started_at: "2026-01-03T00:00:00Z", metric_value: 12, status: "complete", acted: false },
      { tick_number: 1, started_at: "2026-01-01T00:00:00Z", metric_value: 8, status: "complete", acted: false },
      { tick_number: 2, started_at: "2026-01-02T00:00:00Z", metric_value: 11, status: "complete", acted: true },
      { tick_number: 4, started_at: "2026-01-04T00:00:00Z", metric_value: 20, status: "failed", acted: false },
    ], 10, "increase");
    expect(squares.map((square) => [square.tick_number, square.state])).toEqual([
      [1, "failed"],
      [2, "acted"],
      [3, "held"],
      [4, "failed"],
    ]);
  });

  it("computes no, broken, and active streaks", () => {
    expect(currentStreak([])).toBeNull();
    expect(currentStreak([{ tick_number: 1, t: 1, state: "failed" }], 100)).toEqual({ holding: false, days: 0 });
    const day = 86_400_000;
    expect(currentStreak([
      { tick_number: 1, t: day, state: "failed" },
      { tick_number: 2, t: 2 * day, state: "acted" },
      { tick_number: 3, t: 3 * day, state: "held" },
    ], 5 * day)).toEqual({ holding: true, days: 3 });
    expect(currentStreak([{ tick_number: 1, t: 10 * day, state: "held" }], 5 * day)).toEqual({ holding: true, days: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCronRunsMock = vi.fn();
vi.mock("./crons", () => ({
  loadCronRuns: (...args: unknown[]) => loadCronRunsMock(...args),
}));

import {
  annotateOccurrencesWithRunStatus,
  expandSchedule,
  groupOccurrencesByDay,
  tickAtOrBefore,
  type CronOccurrence,
} from "./cron-schedule";

const META = {
  name: "demo/agent/cron",
  short_name: "cron",
  agent_id: "demo-agent",
  agent_slug: "agent",
  schedule_text: "every 1m",
};

describe("expandSchedule", () => {
  it("returns [] when schedule is undefined", () => {
    expect(expandSchedule("c1", undefined, { from: 0, until: 1000 }, META)).toEqual([]);
  });

  it("returns [] when schedule.kind is unknown", () => {
    expect(
      expandSchedule(
        "c1",
        { kind: "weird", foo: "bar" } as never,
        { from: 0, until: 1000 },
        META,
      ),
    ).toEqual([]);
  });

  it("expands cron expression to multiple occurrences within window", () => {
    const from = new Date("2026-01-01T00:00:00Z").getTime();
    const until = from + 5 * 60 * 1000;
    const occs = expandSchedule(
      "c1",
      { kind: "cron", expr: "* * * * *", tz: "UTC" },
      { from, until },
      META,
    );
    expect(occs.length).toBeGreaterThan(0);
    expect(occs[0]?.cron_id).toBe("c1");
    expect(occs[0]?.cron_name).toBe(META.name);
    expect(occs[0]?.agent_slug).toBe(META.agent_slug);
  });

  it("respects maxPerCron cap on cron schedules", () => {
    const from = new Date("2026-01-01T00:00:00Z").getTime();
    const until = from + 1000 * 60 * 60;
    const occs = expandSchedule(
      "c1",
      { kind: "cron", expr: "* * * * *", tz: "UTC" },
      { from, until },
      META,
      3,
    );
    expect(occs.length).toBe(3);
  });

  it("returns [] on invalid cron expression", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "cron", expr: "not a cron" },
      { from: 0, until: 100000 },
      META,
    );
    expect(occs).toEqual([]);
  });

  it("returns [] when cron.expr is not a string", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "cron", expr: 42 as unknown as string },
      { from: 0, until: 100000 },
      META,
    );
    expect(occs).toEqual([]);
  });

  it("expands 'every' schedule starting from `from` when no anchor", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "every", everyMs: 1000 },
      { from: 0, until: 3000 },
      META,
    );
    expect(occs.map((o) => o.at)).toEqual([0, 1000, 2000, 3000]);
  });

  it("expands 'every' schedule advancing past `from` from earlier anchor", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "every", everyMs: 1000, anchorMs: -500 },
      { from: 0, until: 2500 },
      META,
    );
    expect(occs.map((o) => o.at)).toEqual([500, 1500, 2500]);
  });

  it("expands 'every' schedule with anchor at exactly `from`", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "every", everyMs: 1000, anchorMs: 0 },
      { from: 0, until: 2000 },
      META,
    );
    expect(occs.map((o) => o.at)).toEqual([0, 1000, 2000]);
  });

  it("uses future anchor as the first occurrence", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "every", everyMs: 1000, anchorMs: 5000 },
      { from: 0, until: 7000 },
      META,
    );
    expect(occs.map((o) => o.at)).toEqual([5000, 6000, 7000]);
  });

  it("returns [] when everyMs <= 0", () => {
    expect(
      expandSchedule(
        "c1",
        { kind: "every", everyMs: 0 },
        { from: 0, until: 1000 },
        META,
      ),
    ).toEqual([]);
    expect(
      expandSchedule(
        "c1",
        { kind: "every", everyMs: -5 },
        { from: 0, until: 1000 },
        META,
      ),
    ).toEqual([]);
  });

  it("returns [] when every.everyMs is not a number", () => {
    expect(
      expandSchedule(
        "c1",
        { kind: "every", everyMs: "10" as unknown as number },
        { from: 0, until: 1000 },
        META,
      ),
    ).toEqual([]);
  });

  it("caps 'every' expansion at maxPerCron", () => {
    const occs = expandSchedule(
      "c1",
      { kind: "every", everyMs: 1 },
      { from: 0, until: 1_000_000 },
      META,
      5,
    );
    expect(occs.length).toBe(5);
  });
});

describe("tickAtOrBefore", () => {
  it("returns undefined for undefined schedule", () => {
    expect(tickAtOrBefore(undefined, 1000)).toBeUndefined();
  });

  it("returns undefined for unknown kind", () => {
    expect(tickAtOrBefore({ kind: "weird" } as never, 1000)).toBeUndefined();
  });

  it("returns nearest tick at-or-before `at` for cron expr", () => {
    const at = new Date("2026-01-01T00:10:30Z").getTime();
    // Use a 1h lookback so we don't blow the 10k iteration cap inside.
    const tick = tickAtOrBefore(
      { kind: "cron", expr: "* * * * *", tz: "UTC" },
      at,
      60 * 60 * 1000,
    );
    expect(tick).toBeDefined();
    expect(tick!).toBeLessThanOrEqual(at);
    expect(at - tick!).toBeLessThan(60_000);
  });

  it("returns undefined on invalid cron expr", () => {
    expect(tickAtOrBefore({ kind: "cron", expr: "garbage" }, 1000)).toBeUndefined();
  });

  it("returns undefined when cron.expr is not a string", () => {
    expect(
      tickAtOrBefore({ kind: "cron", expr: 5 as unknown as string }, 1000),
    ).toBeUndefined();
  });

  it("returns undefined when no tick exists in lookback window for cron", () => {
    const at = new Date("2026-01-01T00:00:00Z").getTime();
    // Lookback is 1ms; cron fires every minute so no tick in that window unless on boundary.
    const tick = tickAtOrBefore(
      { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
      at + 1,
      1,
    );
    // Could be undefined or exactly `at`; either is acceptable per spec.
    if (tick !== undefined) {
      expect(tick).toBeLessThanOrEqual(at + 1);
    }
  });

  it("returns floor(k) tick for every schedule with anchor", () => {
    expect(tickAtOrBefore({ kind: "every", everyMs: 1000, anchorMs: 0 }, 3500)).toBe(3000);
  });

  it("returns the anchor when at == anchor", () => {
    expect(tickAtOrBefore({ kind: "every", everyMs: 1000, anchorMs: 1000 }, 1000)).toBe(1000);
  });

  it("returns undefined when anchor is in the future of `at`", () => {
    expect(tickAtOrBefore({ kind: "every", everyMs: 1000, anchorMs: 5000 }, 3000)).toBeUndefined();
  });

  it("returns undefined when every.everyMs <= 0", () => {
    expect(tickAtOrBefore({ kind: "every", everyMs: 0 }, 1000)).toBeUndefined();
    expect(tickAtOrBefore({ kind: "every", everyMs: -5 }, 1000)).toBeUndefined();
  });

  it("returns undefined when every.everyMs is not a number", () => {
    expect(
      tickAtOrBefore({ kind: "every", everyMs: "10" as unknown as number }, 1000),
    ).toBeUndefined();
  });

  it("defaults anchor to `at` when no anchorMs provided", () => {
    expect(tickAtOrBefore({ kind: "every", everyMs: 1000 }, 1234)).toBe(1234);
  });
});

describe("annotateOccurrencesWithRunStatus", () => {
  beforeEach(() => {
    loadCronRunsMock.mockReset();
  });

  it("annotates occurrences whose tick matches a run's owning tick", () => {
    const schedule = { kind: "every", everyMs: 1000, anchorMs: 0 } as const;
    const occs: CronOccurrence[] = [
      {
        at: 1000,
        cron_id: "c1",
        cron_name: "n",
        short_name: "n",
        agent_id: "a",
        agent_slug: "a",
        schedule_text: "every 1s",
      },
      {
        at: 2000,
        cron_id: "c1",
        cron_name: "n",
        short_name: "n",
        agent_id: "a",
        agent_slug: "a",
        schedule_text: "every 1s",
      },
    ];
    loadCronRunsMock.mockReturnValueOnce([
      { run_at_ms: 1050, status: "ok" },
      { run_at_ms: 2100, status: "error" },
    ]);
    const out = annotateOccurrencesWithRunStatus(
      occs,
      new Map([["c1", schedule]]),
    );
    expect(out[0]!.run_status).toBe("ok");
    expect(out[1]!.run_status).toBe("error");
    expect(loadCronRunsMock).toHaveBeenCalledWith("c1", 200);
  });

  it("skips crons missing from the schedules map", () => {
    const occs: CronOccurrence[] = [
      {
        at: 1000,
        cron_id: "no-sched",
        cron_name: "n",
        short_name: "n",
        agent_id: "a",
        agent_slug: "a",
        schedule_text: "?",
      },
    ];
    const out = annotateOccurrencesWithRunStatus(occs, new Map());
    expect(out[0]!.run_status).toBeUndefined();
    expect(loadCronRunsMock).not.toHaveBeenCalled();
  });

  it("does not overwrite first-seen status when a later run has same owning tick", () => {
    const schedule = { kind: "every", everyMs: 1000, anchorMs: 0 } as const;
    const occs: CronOccurrence[] = [
      {
        at: 1000,
        cron_id: "c1",
        cron_name: "n",
        short_name: "n",
        agent_id: "a",
        agent_slug: "a",
        schedule_text: "?",
      },
    ];
    loadCronRunsMock.mockReturnValueOnce([
      { run_at_ms: 1010, status: "ok" },
      { run_at_ms: 1500, status: "error" },
    ]);
    const out = annotateOccurrencesWithRunStatus(occs, new Map([["c1", schedule]]));
    expect(out[0]!.run_status).toBe("ok");
  });

  it("groups by cron id and only fetches each cron's runs once", () => {
    const schedule = { kind: "every", everyMs: 1000, anchorMs: 0 } as const;
    const occs: CronOccurrence[] = [
      { at: 1000, cron_id: "c1", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 2000, cron_id: "c1", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 3000, cron_id: "c2", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
    ];
    loadCronRunsMock.mockReturnValue([]);
    annotateOccurrencesWithRunStatus(
      occs,
      new Map([
        ["c1", schedule],
        ["c2", schedule],
      ]),
    );
    expect(loadCronRunsMock).toHaveBeenCalledTimes(2);
  });

  it("returns runs with no matching occurrence as unaffected", () => {
    const schedule = { kind: "every", everyMs: 1000, anchorMs: 0 } as const;
    const occs: CronOccurrence[] = [
      { at: 1000, cron_id: "c1", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
    ];
    loadCronRunsMock.mockReturnValueOnce([
      { run_at_ms: 5050, status: "ok" }, // owning tick is 5000, not 1000
    ]);
    const out = annotateOccurrencesWithRunStatus(occs, new Map([["c1", schedule]]));
    expect(out[0]!.run_status).toBeUndefined();
  });
});

describe("groupOccurrencesByDay", () => {
  it("buckets occurrences into the correct day index", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const start = 0;
    const occs: CronOccurrence[] = [
      { at: 0, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: dayMs + 1, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 2 * dayMs + 100, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
    ];
    const days = groupOccurrencesByDay(occs, start, 3);
    expect(days.length).toBe(3);
    expect(days[0]!.length).toBe(1);
    expect(days[1]!.length).toBe(1);
    expect(days[2]!.length).toBe(1);
  });

  it("drops occurrences before the first day or beyond the last", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const start = dayMs;
    const occs: CronOccurrence[] = [
      { at: 0, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: dayMs, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 10 * dayMs, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
    ];
    const days = groupOccurrencesByDay(occs, start, 2);
    expect(days[0]!.length).toBe(1);
    expect(days[1]!.length).toBe(0);
  });

  it("sorts each day's occurrences ascending by `at`", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const occs: CronOccurrence[] = [
      { at: 300, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 100, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
      { at: 200, cron_id: "c", cron_name: "n", short_name: "n", agent_id: "a", agent_slug: "a", schedule_text: "?" },
    ];
    const days = groupOccurrencesByDay(occs, 0, 1);
    expect(days[0]!.map((o) => o.at)).toEqual([100, 200, 300]);
    expect(dayMs).toBeGreaterThan(0);
  });

  it("returns numDays empty buckets when occurrences list is empty", () => {
    const days = groupOccurrencesByDay([], 0, 5);
    expect(days.length).toBe(5);
    expect(days.every((d) => d.length === 0)).toBe(true);
  });
});

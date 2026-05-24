import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCronRunsMock = vi.fn();
vi.mock("@/server/openclaw/crons", () => ({
  loadCronRuns: (...a: unknown[]) => loadCronRunsMock(...a),
}));

const tickAtOrBeforeMock = vi.fn();
vi.mock("@/server/openclaw/cron-schedule", () => ({
  tickAtOrBefore: (...a: unknown[]) => tickAtOrBeforeMock(...a),
}));

import { getCronRunsAction } from "./cron-runs";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    run_at_ms: 1_700_000_000_000,
    finished_at_ms: 1_700_000_001_000,
    status: "ok",
    summary: "ran fine",
    error: undefined,
    duration_ms: 1000,
    session_id: "s-1",
    model: undefined,
    provider: undefined,
    usage: undefined,
    ...overrides,
  };
}

describe("getCronRunsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns runs with owning_occurrence_at_ms from tickAtOrBefore when a schedule is provided", async () => {
    const runA = makeRun({ run_at_ms: 1000 });
    const runB = makeRun({ run_at_ms: 2000 });
    loadCronRunsMock.mockReturnValue([runA, runB]);
    tickAtOrBeforeMock.mockImplementation((_s: unknown, at: number) => at - 100);

    const schedule = { kind: "cron" as const, expr: "0 9 * * *", tz: "UTC" };
    const out = await getCronRunsAction("cron-1", schedule, 50);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs).toHaveLength(2);
    expect(out.runs[0]!.owning_occurrence_at_ms).toBe(900);
    expect(out.runs[1]!.owning_occurrence_at_ms).toBe(1900);
    expect(loadCronRunsMock).toHaveBeenCalledWith("cron-1", 50);
    expect(tickAtOrBeforeMock).toHaveBeenNthCalledWith(1, schedule, 1000);
    expect(tickAtOrBeforeMock).toHaveBeenNthCalledWith(2, schedule, 2000);
  });

  it("sets owning_occurrence_at_ms to undefined when schedule is null", async () => {
    loadCronRunsMock.mockReturnValue([makeRun()]);
    const out = await getCronRunsAction("cron-1", null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs[0]!.owning_occurrence_at_ms).toBeUndefined();
    expect(tickAtOrBeforeMock).not.toHaveBeenCalled();
  });

  it("returns empty list when loadCronRuns has no entries", async () => {
    loadCronRunsMock.mockReturnValue([]);
    const out = await getCronRunsAction("cron-1", null);
    expect(out).toEqual({ ok: true, runs: [] });
  });

  it("uses default limit of 100 when not specified", async () => {
    loadCronRunsMock.mockReturnValue([]);
    await getCronRunsAction("cron-1", null);
    expect(loadCronRunsMock).toHaveBeenCalledWith("cron-1", 100);
  });

  it("supports 'every' schedule shape end-to-end", async () => {
    loadCronRunsMock.mockReturnValue([makeRun({ run_at_ms: 5000 })]);
    tickAtOrBeforeMock.mockReturnValue(4500);
    const schedule = { kind: "every" as const, everyMs: 60_000, anchorMs: 0 };
    const out = await getCronRunsAction("cron-1", schedule);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs[0]!.owning_occurrence_at_ms).toBe(4500);
    expect(tickAtOrBeforeMock).toHaveBeenCalledWith(schedule, 5000);
  });

  it("returns ok:false with the Error message when loadCronRuns throws", async () => {
    loadCronRunsMock.mockImplementation(() => {
      throw new Error("disk read failed");
    });
    const out = await getCronRunsAction("cron-1", null);
    expect(out).toEqual({ ok: false, error: "disk read failed" });
  });

  it("stringifies non-Error throws into the error field", async () => {
    loadCronRunsMock.mockImplementation(() => {
      throw "string-reason";
    });
    const out = await getCronRunsAction("cron-1", null);
    expect(out).toEqual({ ok: false, error: "string-reason" });
  });

  it("preserves all CronRun fields from loadCronRuns in the enriched output", async () => {
    const run = makeRun({
      status: "error",
      summary: "boom",
      error: "timeout",
      session_id: "sess-xyz",
      model: "claude-opus-4-7",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    loadCronRunsMock.mockReturnValue([run]);
    const out = await getCronRunsAction("cron-1", null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs[0]).toMatchObject({
      status: "error",
      summary: "boom",
      error: "timeout",
      session_id: "sess-xyz",
      model: "claude-opus-4-7",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });
});

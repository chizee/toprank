import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverTicks: vi.fn(),
  runTicks: vi.fn(),
  syncPrs: vi.fn(),
}));
vi.mock("@/server/goals/tick", () => ({ runDueGoalTicks: mocks.runTicks }));
vi.mock("@/server/goals/pr-sync", () => ({ syncDueGoalPrs: mocks.syncPrs }));
vi.mock("@/server/goals/recovery", () => ({
  recoverInterruptedGoalTicks: mocks.recoverTicks,
}));

import { ensureSchedulerRunning, stopScheduler } from "./tick";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.recoverTicks.mockReturnValue({
    recovered: 0,
    completed: 0,
    failed: 0,
    active: 0,
  });
  mocks.runTicks.mockResolvedValue(undefined);
  mocks.syncPrs.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stopScheduler();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("runs immediately, repeats every 30s, and starts only once", async () => {
  ensureSchedulerRunning();
  ensureSchedulerRunning();
  expect(mocks.recoverTicks).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.runTicks).toHaveBeenCalledTimes(1);
  expect(mocks.syncPrs).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.runTicks).toHaveBeenCalledTimes(2);
  stopScheduler();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.runTicks).toHaveBeenCalledTimes(2);
});

it("logs recovery failures but still starts the scheduler", async () => {
  mocks.recoverTicks.mockImplementationOnce(() => {
    throw new Error("recovery failed");
  });
  ensureSchedulerRunning();
  await vi.advanceTimersByTimeAsync(0);
  expect(console.error).toHaveBeenCalledWith(
    "[scheduler] interrupted tick recovery failed:",
    expect.any(Error),
  );
  expect(mocks.runTicks).toHaveBeenCalledTimes(1);
});

it("reports interrupted ticks recovered during startup", () => {
  mocks.recoverTicks.mockReturnValueOnce({
    recovered: 3,
    completed: 1,
    failed: 2,
    active: 0,
  });
  ensureSchedulerRunning();
  expect(console.warn).toHaveBeenCalledWith(
    "[scheduler] recovered 3 interrupted goal tick(s): 1 completed, 2 failed",
  );
});

it("logs independent tick and PR sweep failures", async () => {
  mocks.runTicks.mockRejectedValue(new Error("tick failed"));
  mocks.syncPrs.mockRejectedValue(new Error("pr failed"));
  ensureSchedulerRunning();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  expect(console.error).toHaveBeenCalledWith("[scheduler] goal tick sweep failed:", expect.any(Error));
  expect(console.error).toHaveBeenCalledWith("[scheduler] PR freshness sweep failed:", expect.any(Error));
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runTicks: vi.fn(), syncPrs: vi.fn() }));
vi.mock("@/server/goals/tick", () => ({ runDueGoalTicks: mocks.runTicks }));
vi.mock("@/server/goals/pr-sync", () => ({ syncDueGoalPrs: mocks.syncPrs }));

import { ensureSchedulerRunning, stopScheduler } from "./tick";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.runTicks.mockResolvedValue(undefined);
  mocks.syncPrs.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.runTicks).toHaveBeenCalledTimes(1);
  expect(mocks.syncPrs).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.runTicks).toHaveBeenCalledTimes(2);
  stopScheduler();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.runTicks).toHaveBeenCalledTimes(2);
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

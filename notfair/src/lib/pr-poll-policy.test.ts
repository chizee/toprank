import { describe, expect, it } from "vitest";

import {
  computeNextSyncAt,
  nextSyncDelayMs,
  SYNC_ERROR_RETRY_MS,
} from "@/lib/pr-poll-policy";

const MIN = 60_000;
const HOUR = 3_600_000;

describe("nextSyncDelayMs", () => {
  it("polls fast right after activity, decaying to an hourly cap", () => {
    expect(nextSyncDelayMs(0)).toBe(2 * MIN);
    expect(nextSyncDelayMs(59 * MIN)).toBe(2 * MIN);
    expect(nextSyncDelayMs(2 * HOUR)).toBe(10 * MIN);
    expect(nextSyncDelayMs(23 * HOUR)).toBe(10 * MIN);
    expect(nextSyncDelayMs(48 * HOUR)).toBe(30 * MIN);
    expect(nextSyncDelayMs(100 * HOUR)).toBe(60 * MIN);
    expect(nextSyncDelayMs(1000 * HOUR)).toBe(60 * MIN);
  });
});

describe("computeNextSyncAt", () => {
  it("schedules from now, keyed off quietness", () => {
    const now = "2026-07-13T12:00:00.000Z";
    // Fresh activity → 2 minutes out.
    expect(computeNextSyncAt(now, "2026-07-13T11:59:00.000Z")).toBe(
      "2026-07-13T12:02:00.000Z",
    );
    // Two days quiet → 30 minutes out.
    expect(computeNextSyncAt(now, "2026-07-11T12:00:00.000Z")).toBe(
      "2026-07-13T12:30:00.000Z",
    );
  });

  it("treats a garbage activity timestamp as fresh (fast lane)", () => {
    const now = "2026-07-13T12:00:00.000Z";
    expect(computeNextSyncAt(now, "not-a-date")).toBe(
      "2026-07-13T12:02:00.000Z",
    );
  });
});

describe("SYNC_ERROR_RETRY_MS", () => {
  it("retries failures on a short fixed delay", () => {
    expect(SYNC_ERROR_RETRY_MS).toBe(5 * MIN);
  });
});

import { describe, expect, it } from "vitest";
import { timeUntil } from "./time-ago";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

describe("timeUntil", () => {
  it("formats each magnitude compactly", () => {
    expect(timeUntil("2026-07-17T12:00:30.000Z", NOW)).toBe("in 30s");
    expect(timeUntil("2026-07-17T12:45:00.000Z", NOW)).toBe("in 45m");
    expect(timeUntil("2026-07-17T15:00:00.000Z", NOW)).toBe("in 3h");
    expect(timeUntil("2026-07-19T12:00:00.000Z", NOW)).toBe("in 2d");
  });

  it("rounds up so a lock never reads as shorter than it is", () => {
    expect(timeUntil("2026-07-17T13:00:01.000Z", NOW)).toBe("in 2h");
    expect(timeUntil("2026-07-17T12:00:31.000Z", NOW)).toBe("in 31s");
  });

  it("reads 'now' once the moment has passed", () => {
    expect(timeUntil("2026-07-17T11:59:00.000Z", NOW)).toBe("now");
    expect(timeUntil("2026-07-17T12:00:00.000Z", NOW)).toBe("now");
  });
});

import { describe, expect, it } from "vitest";

import { findOpenTurn, isOpenTurnLive, OPEN_TURN_STALE_MS } from "./turn-state";

const t0 = 1_800_000_000_000;
const lc = (phase: string, ts: number) => ({ kind: "lifecycle", ts, phase });
const tool = (ts: number) => ({ kind: "tool_call", ts });

describe("findOpenTurn", () => {
  it("returns null for an empty log or a completed last turn", () => {
    expect(findOpenTurn([])).toBeNull();
    expect(findOpenTurn([lc("start", t0), tool(t0 + 1), lc("done", t0 + 2)])).toBeNull();
  });

  it("detects a trailing start with no done as an open turn", () => {
    const turn = findOpenTurn([lc("start", t0), tool(t0 + 5_000)]);
    expect(turn).toEqual({ startedAt: t0, lastEventTs: t0 + 5_000 });
  });

  it("is not fooled by earlier completed turns in the same thread", () => {
    const events = [
      lc("start", t0),
      lc("done", t0 + 1),
      lc("start", t0 + 10),
      tool(t0 + 20),
    ];
    expect(findOpenTurn(events)).toEqual({ startedAt: t0 + 10, lastEventTs: t0 + 20 });
  });

  it("skips non-boundary lifecycle phases (warming etc.)", () => {
    const events = [lc("start", t0), lc("warming", t0 + 1), tool(t0 + 2)];
    expect(findOpenTurn(events)).toEqual({ startedAt: t0, lastEventTs: t0 + 2 });
  });
});

describe("isOpenTurnLive", () => {
  const turn = { startedAt: t0, lastEventTs: t0 };
  it("is live while events are fresh, stale after the cutoff", () => {
    expect(isOpenTurnLive(turn, t0 + 1_000)).toBe(true);
    expect(isOpenTurnLive(turn, t0 + OPEN_TURN_STALE_MS + 1)).toBe(false);
    expect(isOpenTurnLive(null, t0)).toBe(false);
  });
});

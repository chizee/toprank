import { describe, expect, it } from "vitest";
import {
  registerLiveTurn,
  releaseLiveTurn,
  stopLiveTurn,
} from "./live-turns";

describe("live chat turn registry", () => {
  it("stops a registered turn by aborting its controller", () => {
    const ctrl = registerLiveTurn("s1");
    expect(ctrl.signal.aborted).toBe(false);
    expect(stopLiveTurn("s1")).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    releaseLiveTurn("s1", ctrl);
  });

  it("reports nothing to stop for an idle session", () => {
    expect(stopLiveTurn("nope")).toBe(false);
  });

  it("release is a no-op after the slot was re-registered by a newer turn", () => {
    const old = registerLiveTurn("s2");
    const fresh = registerLiveTurn("s2");
    releaseLiveTurn("s2", old); // stale release must not evict the live turn
    expect(stopLiveTurn("s2")).toBe(true);
    expect(fresh.signal.aborted).toBe(true);
    expect(old.signal.aborted).toBe(false);
    releaseLiveTurn("s2", fresh);
  });

  it("a released turn can no longer be stopped", () => {
    const ctrl = registerLiveTurn("s3");
    releaseLiveTurn("s3", ctrl);
    expect(stopLiveTurn("s3")).toBe(false);
  });
});

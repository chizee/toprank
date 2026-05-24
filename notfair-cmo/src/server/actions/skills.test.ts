import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}));

const setSkillEnabledMock = vi.fn();
vi.mock("@/server/openclaw/gateway-rpc", () => ({
  setSkillEnabled: (...a: unknown[]) => setSkillEnabledMock(...a),
}));

import { setSkillEnabledAction } from "./skills";

describe("setSkillEnabledAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:false when skillKey is empty (no gateway call)", async () => {
    const out = await setSkillEnabledAction("", true, "demo-google-ads");
    expect(out).toEqual({ ok: false, error: "skillKey is required" });
    expect(setSkillEnabledMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("calls setSkillEnabled with the provided key + enabled flag and revalidates layout", async () => {
    setSkillEnabledMock.mockResolvedValue(undefined);
    const out = await setSkillEnabledAction("toprank:google-ads", true, "demo-google-ads");
    expect(out).toEqual({ ok: true });
    expect(setSkillEnabledMock).toHaveBeenCalledWith("toprank:google-ads", true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("passes enabled=false through to the gateway when disabling a skill", async () => {
    setSkillEnabledMock.mockResolvedValue(undefined);
    const out = await setSkillEnabledAction("toprank:meta-ads", false, "demo-meta");
    expect(out).toEqual({ ok: true });
    expect(setSkillEnabledMock).toHaveBeenCalledWith("toprank:meta-ads", false);
  });

  it("captures gateway Error and surfaces its message (no revalidate)", async () => {
    setSkillEnabledMock.mockRejectedValue(new Error("gateway down"));
    const out = await setSkillEnabledAction("k", true, "a");
    expect(out).toEqual({ ok: false, error: "gateway down" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("stringifies non-Error rejections into the error field", async () => {
    setSkillEnabledMock.mockRejectedValue("plain-string-reason");
    const out = await setSkillEnabledAction("k", true, "a");
    expect(out).toEqual({ ok: false, error: "plain-string-reason" });
  });

  it("ignores agentSlug (workspace-wide config) but still succeeds", async () => {
    setSkillEnabledMock.mockResolvedValue(undefined);
    const out = await setSkillEnabledAction("k", true, "literally-any-agent");
    expect(out).toEqual({ ok: true });
    expect(setSkillEnabledMock).toHaveBeenCalledTimes(1);
  });
});

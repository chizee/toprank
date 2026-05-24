import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}));

const createCronMock = vi.fn();
const disableCronMock = vi.fn();
const enableCronMock = vi.fn();
const removeCronMock = vi.fn();
const invalidateCronCacheMock = vi.fn();
vi.mock("@/server/openclaw/crons", () => ({
  createCron: (...a: unknown[]) => createCronMock(...a),
  disableCron: (...a: unknown[]) => disableCronMock(...a),
  enableCron: (...a: unknown[]) => enableCronMock(...a),
  removeCron: (...a: unknown[]) => removeCronMock(...a),
  invalidateCronCache: () => invalidateCronCacheMock(),
}));

const updateCronMessageMock = vi.fn();
vi.mock("@/server/openclaw/gateway-rpc", () => ({
  updateCronMessage: (...a: unknown[]) => updateCronMessageMock(...a),
}));

const logAgentActionMock = vi.fn();
vi.mock("@/server/db/agent-actions", () => ({
  logAgentAction: (...a: unknown[]) => logAgentActionMock(...a),
}));

// scheduleCronAction looks up the agent's full id from the project's
// agent roster — the id encodes the personal name now, so we can't
// synthesize it from template key alone.
const listProjectAgentsMock = vi.fn(async (..._a: unknown[]) => [
  {
    agent_id: "demo-cmo-greg",
    slug: "cmo-greg",
    name: "Greg",
    template_key: "cmo" as const,
    is_template_default: true,
  },
  {
    agent_id: "demo-google-ads-ana",
    slug: "google-ads-ana",
    name: "Ana",
    template_key: "google_ads" as const,
    is_template_default: true,
  },
  {
    agent_id: "demo-seo-sam",
    slug: "seo-sam",
    name: "Sam",
    template_key: "seo" as const,
    is_template_default: false,
  },
]);
vi.mock("@/server/agent-meta", () => ({
  listProjectAgents: (...a: unknown[]) => listProjectAgentsMock(...a),
}));

import {
  deleteCronAction,
  pauseCronAction,
  resumeCronAction,
  scheduleCronAction,
  updateCronPromptAction,
} from "./crons";

describe("scheduleCronAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCronMock.mockResolvedValue({ id: "cron-1", name: "demo/google-ads/morning" });
  });

  it("creates a cron with kind=cron, logs the action, and revalidates", async () => {
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "google_ads",
      name: "Morning Audit",
      schedule_kind: "cron",
      schedule_value: "0 9 * * *",
      tz: "UTC",
      brief: "Run a daily account health check.",
    });

    expect(out).toEqual({ ok: true, cron_id: "cron-1", cron_name: "demo/google-ads/morning" });
    expect(createCronMock).toHaveBeenCalledWith({
      project_slug: "demo",
      agent_slug: "google-ads-ana",
      agent_full_id: "demo-google-ads-ana",
      cron_name: "morning-audit",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      message: "Run a daily account health check.",
    });
    expect(logAgentActionMock).toHaveBeenCalledWith({
      project_slug: "demo",
      agent_id: "demo-google-ads-ana",
      action_type: "cron_created",
      summary: "Scheduled 'morning-audit' (cron 0 9 * * *)",
      payload: {
        cron_id: "cron-1",
        cron_name: "demo/google-ads/morning",
        brief: "Run a daily account health check.",
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("creates a cron with kind=every (no tz passthrough)", async () => {
    await scheduleCronAction({
      project_slug: "demo",
      specialist: "seo",
      name: "Hourly Audit",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "Hourly SEO scan.",
    });
    expect(createCronMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "seo-sam",
        agent_full_id: "demo-seo-sam",
        schedule: { kind: "every", duration: "1h" },
      }),
    );
  });

  it("resolves agent_full_id from the project roster (encodes role + personal name)", async () => {
    await scheduleCronAction({
      project_slug: "demo",
      specialist: "google_ads",
      name: "X",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "x",
    });
    const call = createCronMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agent_slug).toBe("google-ads-ana");
    expect(call.agent_full_id).toBe("demo-google-ads-ana");
  });

  it("trims brief whitespace before sending and logging", async () => {
    await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "hello",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "   actual prompt   ",
    });
    expect(createCronMock.mock.calls[0]?.[0].message).toBe("actual prompt");
  });

  it("trims schedule_value whitespace", async () => {
    await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "hello",
      schedule_kind: "cron",
      schedule_value: "   0 9 * * *   ",
      brief: "b",
    });
    expect(createCronMock.mock.calls[0]?.[0].schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: undefined,
    });
  });

  it("returns ok:false when the name cannot be slugified", async () => {
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "   ",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "b",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/Invalid name/);
    expect(createCronMock).not.toHaveBeenCalled();
  });

  it("returns ok:false when brief is empty after trimming", async () => {
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "valid",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "   ",
    });
    expect(out).toEqual({ ok: false, error: "Brief is required." });
    expect(createCronMock).not.toHaveBeenCalled();
  });

  it("returns ok:false when schedule_value is empty after trimming", async () => {
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "valid",
      schedule_kind: "every",
      schedule_value: "   ",
      brief: "brief",
    });
    expect(out).toEqual({ ok: false, error: "Schedule is required." });
    expect(createCronMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with Error message when createCron throws", async () => {
    createCronMock.mockRejectedValue(new Error("openclaw down"));
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "valid",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "b",
    });
    expect(out).toEqual({ ok: false, error: "openclaw down" });
    expect(logAgentActionMock).not.toHaveBeenCalled();
  });

  it("stringifies non-Error rejections from createCron", async () => {
    createCronMock.mockRejectedValue("rope-burn");
    const out = await scheduleCronAction({
      project_slug: "demo",
      specialist: "cmo",
      name: "valid",
      schedule_kind: "every",
      schedule_value: "1h",
      brief: "b",
    });
    expect(out).toEqual({ ok: false, error: "rope-burn" });
  });
});

describe("pauseCronAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disables the cron and revalidates layout", async () => {
    disableCronMock.mockResolvedValue(undefined);
    const out = await pauseCronAction("cron-1");
    expect(out).toEqual({ ok: true });
    expect(disableCronMock).toHaveBeenCalledWith("cron-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns ok:false with the Error message when disableCron throws", async () => {
    disableCronMock.mockRejectedValue(new Error("nope"));
    const out = await pauseCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "nope" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("stringifies non-Error rejections", async () => {
    disableCronMock.mockRejectedValue(42);
    const out = await pauseCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "42" });
  });
});

describe("resumeCronAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enables the cron and revalidates layout", async () => {
    enableCronMock.mockResolvedValue(undefined);
    const out = await resumeCronAction("cron-1");
    expect(out).toEqual({ ok: true });
    expect(enableCronMock).toHaveBeenCalledWith("cron-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns ok:false with the Error message when enableCron throws", async () => {
    enableCronMock.mockRejectedValue(new Error("auth"));
    const out = await resumeCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "auth" });
  });

  it("stringifies non-Error rejections", async () => {
    enableCronMock.mockRejectedValue("disconnected");
    const out = await resumeCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "disconnected" });
  });
});

describe("deleteCronAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the cron and revalidates layout", async () => {
    removeCronMock.mockResolvedValue(undefined);
    const out = await deleteCronAction("cron-1");
    expect(out).toEqual({ ok: true });
    expect(removeCronMock).toHaveBeenCalledWith("cron-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns ok:false with the Error message when removeCron throws", async () => {
    removeCronMock.mockRejectedValue(new Error("missing"));
    const out = await deleteCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "missing" });
  });

  it("stringifies non-Error rejections", async () => {
    removeCronMock.mockRejectedValue("io-err");
    const out = await deleteCronAction("cron-1");
    expect(out).toEqual({ ok: false, error: "io-err" });
  });
});

describe("updateCronPromptAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects empty (whitespace-only) messages without calling the gateway", async () => {
    const out = await updateCronPromptAction("cron-1", "   \n\t");
    expect(out).toEqual({ ok: false, error: "Prompt cannot be empty." });
    expect(updateCronMessageMock).not.toHaveBeenCalled();
    expect(invalidateCronCacheMock).not.toHaveBeenCalled();
  });

  it("trims the message before sending to the gateway", async () => {
    updateCronMessageMock.mockResolvedValue(undefined);
    const out = await updateCronPromptAction("cron-1", "   hello world   ");
    expect(out).toEqual({ ok: true });
    expect(updateCronMessageMock).toHaveBeenCalledWith("cron-1", "hello world");
    expect(invalidateCronCacheMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns the Error message when updateCronMessage throws (and skips cache invalidation)", async () => {
    updateCronMessageMock.mockRejectedValue(new Error("rpc error"));
    const out = await updateCronPromptAction("cron-1", "valid");
    expect(out).toEqual({ ok: false, error: "rpc error" });
    expect(invalidateCronCacheMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("stringifies non-Error rejections", async () => {
    updateCronMessageMock.mockRejectedValue("string-err");
    const out = await updateCronPromptAction("cron-1", "valid");
    expect(out).toEqual({ ok: false, error: "string-err" });
  });
});

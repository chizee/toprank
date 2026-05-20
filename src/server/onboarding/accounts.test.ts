import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

const getMcpConfigMock = vi.fn();
const mcpRpcMock = vi.fn();
vi.mock("@/server/mcp/rpc", () => ({
  getMcpConfig: (...args: unknown[]) => getMcpConfigMock(...args),
  mcpRpc: (...args: unknown[]) => mcpRpcMock(...args),
}));

const getProjectMock = vi.fn();
const setProjectGoogleAdsAccountMock = vi.fn();
vi.mock("@/server/db/projects", () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  setProjectGoogleAdsAccount: (...args: unknown[]) =>
    setProjectGoogleAdsAccountMock(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Dynamic imports inside setOnboardingAccountAction need mocks too — it
// auto-creates the CMO's onboarding task as the final step of the action.
const createTaskMock = vi.fn();
const listTasksMock = vi.fn<(slug: string) => unknown[]>(() => []);
vi.mock("@/server/db/tasks", () => ({
  createTask: (input: unknown) => {
    createTaskMock(input);
    return {
      id: "task-uuid",
      display_id: "acme-1",
      project_slug: "acme",
      agent_id: "acme-cmo",
      title: "Audit the account and propose a starter playbook",
      brief: "...",
      success_criteria: null,
      deadline_iso: null,
      status: "proposed",
      result_json: null,
      error_message: null,
      thread_id: null,
      assigner_agent_id: null,
      created_at: "now",
      updated_at: "now",
    };
  },
  listTasks: (slug: string) => listTasksMock(slug),
}));
vi.mock("@/server/agent-templates", () => ({
  agentNameFor: (slug: string, key: string) => `${slug}-${key.replace(/_/g, "-")}`,
}));

import {
  listGoogleAdsAccounts,
  setOnboardingAccountAction,
} from "./accounts";

// ── Fixtures ───────────────────────────────────────────────────────

const ACCOUNTS_PAYLOAD = {
  accounts: [
    { id: "7384288909", name: "IOW" },
    { id: "7521406707", name: "PawsVIP" },
    { id: "1301265570", name: "InOtherWord.ai" },
    { id: "7073485715", name: "BulkGPT.ai" },
    { id: "3251706605", name: "NotFair" },
  ],
  defaultAccountId: "3251706605",
  totalAccounts: 5,
};

function toolCallResult(payload: unknown): {
  ok: true;
  result: { content: Array<{ type: string; text: string }>; isError: boolean };
} {
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: false,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("listGoogleAdsAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpConfigMock.mockResolvedValue({
      url: "https://notfair.co/api/mcp/google_ads",
      token: "tok",
    });
  });

  it("returns accounts + default_account_id on the real Demo2 shape", async () => {
    mcpRpcMock.mockResolvedValueOnce(toolCallResult(ACCOUNTS_PAYLOAD));
    const r = await listGoogleAdsAccounts("acme");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accounts).toHaveLength(5);
      expect(r.accounts[0]).toEqual({ id: "7384288909", name: "IOW" });
      expect(r.default_account_id).toBe("3251706605");
    }
  });

  it("falls back to id when name is empty", async () => {
    mcpRpcMock.mockResolvedValueOnce(
      toolCallResult({ accounts: [{ id: "123" }], defaultAccountId: null }),
    );
    const r = await listGoogleAdsAccounts("acme");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accounts[0]).toEqual({ id: "123", name: "123" });
    }
  });

  it("returns mcp_not_configured when getMcpConfig returns null", async () => {
    getMcpConfigMock.mockResolvedValueOnce(null);
    const r = await listGoogleAdsAccounts("acme");
    expect(r).toMatchObject({ ok: false, kind: "mcp_not_configured" });
    expect(mcpRpcMock).not.toHaveBeenCalled();
  });

  it("returns rpc error when mcpRpc fails", async () => {
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "http_error",
      status: 401,
    });
    const r = await listGoogleAdsAccounts("acme");
    expect(r).toMatchObject({ ok: false, kind: "rpc" });
  });

  it("returns shape error when payload is missing accounts array", async () => {
    mcpRpcMock.mockResolvedValueOnce(toolCallResult({ totalAccounts: 0 }));
    const r = await listGoogleAdsAccounts("acme");
    expect(r).toMatchObject({ ok: false, kind: "shape" });
  });

  it("returns shape error when JSON is malformed", async () => {
    mcpRpcMock.mockResolvedValueOnce({
      ok: true,
      result: {
        content: [{ type: "text", text: "not json" }],
        isError: false,
      },
    });
    const r = await listGoogleAdsAccounts("acme");
    expect(r).toMatchObject({ ok: false, kind: "shape" });
  });
});

describe("setOnboardingAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpConfigMock.mockResolvedValue({
      url: "https://notfair.co/api/mcp/google_ads",
      token: "tok",
    });
    getProjectMock.mockReturnValue({
      id: "uuid",
      slug: "acme",
      display_name: "Acme",
      created_at: "now",
      archived_at: null,
      google_ads_account_id: null,
    });
    setProjectGoogleAdsAccountMock.mockReturnValue({
      id: "uuid",
      slug: "acme",
      display_name: "Acme",
      created_at: "now",
      archived_at: null,
      google_ads_account_id: "3251706605",
    });
    mcpRpcMock.mockResolvedValue(toolCallResult(ACCOUNTS_PAYLOAD));
  });

  it("persists the selection when account is in the bearer's list", async () => {
    const r = await setOnboardingAccountAction("acme", "3251706605");
    expect(r.ok).toBe(true);
    expect(setProjectGoogleAdsAccountMock).toHaveBeenCalledWith(
      "acme",
      "3251706605",
    );
  });

  it("mints the CMO onboarding task and returns its display_id for the redirect", async () => {
    const r = await setOnboardingAccountAction("acme", "3251706605");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Caller redirects to /agents/cmo/tasks?task=<this>.
      expect(r.task_display_id).toBe("acme-1");
    }
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_slug: "acme",
        agent_id: "acme-cmo",
        status: "proposed",
        title: expect.stringContaining("Audit"),
        brief: expect.stringContaining("3251706605"),
      }),
    );
  });

  it("does NOT double-create the task when a prior audit task already exists", async () => {
    listTasksMock.mockReturnValueOnce([
      {
        id: "prior-uuid",
        display_id: "acme-7",
        project_slug: "acme",
        agent_id: "acme-cmo",
        title: "Audit the account and propose a starter playbook",
        status: "running",
      },
    ]);
    const r = await setOnboardingAccountAction("acme", "3251706605");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task_display_id).toBe("acme-7");
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("rejects an account id NOT in the bearer's list (tamper defense)", async () => {
    const r = await setOnboardingAccountAction("acme", "9999999999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't in this bearer/i);
    expect(setProjectGoogleAdsAccountMock).not.toHaveBeenCalled();
  });

  it("rejects when project doesn't exist", async () => {
    getProjectMock.mockReturnValueOnce(null);
    const r = await setOnboardingAccountAction("missing", "3251706605");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
    expect(mcpRpcMock).not.toHaveBeenCalled();
  });

  it("rejects on empty slug or account id", async () => {
    const r1 = await setOnboardingAccountAction("", "3251706605");
    expect(r1.ok).toBe(false);
    const r2 = await setOnboardingAccountAction("acme", "");
    expect(r2.ok).toBe(false);
  });

  it("surfaces MCP errors when listing accounts fails during validation", async () => {
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "http_error",
      status: 500,
    });
    const r = await setOnboardingAccountAction("acme", "3251706605");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/couldn't verify/i);
    expect(setProjectGoogleAdsAccountMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

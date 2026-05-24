import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────
// approval-wakeup pulls in the gateway, sessions, tasks DB, and approval
// comments. We don't want any real I/O here — every dependency is stubbed.

const getTaskMock = vi.fn();
const unblockTaskMock = vi.fn();
const setTaskThreadIfMissingMock = vi.fn();
vi.mock("@/server/db/tasks", () => ({
  getTask: (...a: unknown[]) => getTaskMock(...a),
  unblockTask: (...a: unknown[]) => unblockTaskMock(...a),
  setTaskThreadIfMissing: (...a: unknown[]) => setTaskThreadIfMissingMock(...a),
}));

const appendCommentMock = vi.fn();
const listCommentsMock = vi.fn();
vi.mock("@/server/db/approvals", () => ({
  appendComment: (...a: unknown[]) => appendCommentMock(...a),
  listComments: (...a: unknown[]) => listCommentsMock(...a),
}));

const buildPendingSessionKeyMock = vi.fn(
  (agent: string, session: string) => `agent:${agent}:${session}`,
);
const findSessionBySessionIdMock = vi.fn();
vi.mock("@/server/openclaw/sessions", () => ({
  buildPendingSessionKey: (...a: unknown[]) => buildPendingSessionKeyMock(...(a as [string, string])),
  findSessionBySessionId: (...a: unknown[]) => findSessionBySessionIdMock(...a),
}));

// streamChatViaGateway is an async iterable. The stub yields a single delta
// event so the wakeup body has something to drain.
const streamMock = vi.fn();
vi.mock("@/server/openclaw/gateway-client", () => ({
  streamChatViaGateway: (...a: unknown[]) => streamMock(...a),
}));

vi.mock("./task-kickoff", async () => {
  const actual =
    await vi.importActual<typeof import("./task-kickoff")>("./task-kickoff");
  return {
    ...actual,
    generateTaskThreadId: () => "minted-thread-id",
  };
});

import { wakeTaskOnApprovalResolution } from "./approval-wakeup";

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "ap-deadbeef0123",
    project_slug: "demo",
    agent_id: "demo-google-ads",
    task_id: "task-1",
    action_summary: "Raise CPC bid",
    action_type: "bid_change" as const,
    cost_estimate_usd: 0,
    reasoning: null,
    payload_json: "{}",
    status: "approved" as const,
    decision_note: "ok",
    decided_by_kind: "user" as const,
    decided_by_id: null,
    created_at: "2026-05-01T00:00:00Z",
    resolved_at: "2026-05-02T00:00:00Z",
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    display_id: "demo-1",
    project_slug: "demo",
    agent_id: "demo-google-ads",
    title: "t",
    brief: "b",
    success_criteria: null,
    deadline_iso: null,
    status: "blocked" as const,
    result_json: null,
    error_message: null,
    thread_id: "thread-abc",
    assigner_agent_id: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

async function* yieldDelta(text: string) {
  yield { kind: "delta", text } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockImplementation(() => yieldDelta("agent reply"));
});

describe("wakeTaskOnApprovalResolution", () => {
  it("is a no-op when the approval has no task_id", async () => {
    await wakeTaskOnApprovalResolution(makeApproval({ task_id: null }));
    expect(getTaskMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the task is terminal (succeeded/failed/cancelled)", async () => {
    getTaskMock.mockReturnValue(makeTask({ status: "done" }));
    await wakeTaskOnApprovalResolution(makeApproval());
    expect(streamMock).not.toHaveBeenCalled();
    expect(unblockTaskMock).not.toHaveBeenCalled();
  });

  it("unblocks the task on approve and streams a green-light message", async () => {
    getTaskMock.mockReturnValue(makeTask());
    await wakeTaskOnApprovalResolution(makeApproval({ status: "approved" }));
    expect(unblockTaskMock).toHaveBeenCalledWith("task-1");
    expect(streamMock).toHaveBeenCalledTimes(1);
    const arg = streamMock.mock.calls[0]![0]!;
    expect(arg.message).toMatch(/APPROVED/);
  });

  it("unblocks on reject too (agent decides next step)", async () => {
    getTaskMock.mockReturnValue(makeTask());
    await wakeTaskOnApprovalResolution(makeApproval({ status: "rejected" }));
    expect(unblockTaskMock).toHaveBeenCalledWith("task-1");
    const arg = streamMock.mock.calls[0]![0]!;
    expect(arg.message).toMatch(/REJECTED/);
  });

  it("does NOT unblock on revision_requested (task stays blocked)", async () => {
    getTaskMock.mockReturnValue(makeTask());
    await wakeTaskOnApprovalResolution(
      makeApproval({ status: "revision_requested", decision_note: "narrow scope" }),
    );
    expect(unblockTaskMock).not.toHaveBeenCalled();
    const arg = streamMock.mock.calls[0]![0]!;
    expect(arg.message).toMatch(/needs revision/);
    expect(arg.message).toMatch(/narrow scope/);
  });

  it("appends a system comment recording the delivery", async () => {
    getTaskMock.mockReturnValue(makeTask());
    await wakeTaskOnApprovalResolution(makeApproval({ status: "approved" }));
    expect(appendCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approval_id: "ap-deadbeef0123",
        author_kind: "system",
        body: expect.stringContaining("Delivered to demo-google-ads"),
      }),
    );
  });

  it("mints a thread when the task has none yet", async () => {
    getTaskMock.mockReturnValue(makeTask({ thread_id: null }));
    setTaskThreadIfMissingMock.mockReturnValue({
      ...makeTask(),
      thread_id: "minted-thread-id",
    });
    await wakeTaskOnApprovalResolution(makeApproval());
    expect(setTaskThreadIfMissingMock).toHaveBeenCalledWith(
      "task-1",
      "minted-thread-id",
    );
    const arg = streamMock.mock.calls[0]![0]!;
    expect(arg.sessionId).toBe("minted-thread-id");
  });

  it("drains the gateway stream so the agent's MCP tool calls during the turn can fire", async () => {
    getTaskMock.mockReturnValue(makeTask());
    streamMock.mockImplementation(() => yieldDelta("ack — proceeding"));
    await wakeTaskOnApprovalResolution(makeApproval({ status: "approved" }));
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("swallows gateway stream errors without throwing", async () => {
    getTaskMock.mockReturnValue(makeTask());
    streamMock.mockImplementation(async function* () {
      yield { kind: "error", message: "boom" } as const;
    });
    await expect(
      wakeTaskOnApprovalResolution(makeApproval({ status: "approved" })),
    ).resolves.toBeUndefined();
    // Comment about delivery is still recorded so the inbox thread has a trail.
    expect(appendCommentMock).toHaveBeenCalled();
  });
});

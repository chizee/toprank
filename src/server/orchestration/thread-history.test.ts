import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/types";

const findSessionBySessionIdMock = vi.fn();
const loadSessionHistoryMock = vi.fn();
vi.mock("@/server/openclaw/sessions", () => ({
  findSessionBySessionId: (agentFullId: string, threadId: string) =>
    findSessionBySessionIdMock(agentFullId, threadId),
  loadSessionHistory: (agentFullId: string, sessionId: string) =>
    loadSessionHistoryMock(agentFullId, sessionId),
  buildPendingSessionKey: (agentFullId: string, threadId: string) =>
    `agent:${agentFullId}:${threadId}`,
}));

import { loadThreadHistory, shouldAutoKickoffTask } from "./thread-history";

const baseTask: Task = {
  id: "task-1",
  project_slug: "demo",
  agent_id: "demo-google-ads",
  title: "Install conv tracking",
  brief: "Do it.",
  success_criteria: null,
  deadline_iso: null,
  status: "proposed",
  result_json: null,
  error_message: null,
  thread_id: "thread-abc",
  assigner_agent_id: "demo-cmo",
  created_at: "now",
  updated_at: "now",
};

describe("loadThreadHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves threadId → OpenClaw sessionId, then loads history with sessionId (not threadId)", () => {
    // URL threadId is "thread-abc" but OpenClaw's internal sessionId for
    // that thread is "internal-xyz" — distinct values. Previous bug: we
    // called loadSessionHistory(threadId), got an empty file, kickoff
    // re-fired. Fix: resolve via findSessionBySessionId first.
    findSessionBySessionIdMock.mockReturnValueOnce({
      sessionId: "internal-xyz",
      label: "thread-abc",
      sessionKey: "agent:demo-google-ads:thread-abc",
      lastInteractionAt: 1,
      pending: false,
    });
    loadSessionHistoryMock.mockReturnValueOnce([
      { id: "0", role: "user", body: "(task assignment) ...", timestamp: 1 },
      { id: "1", role: "assistant", body: "On it.", timestamp: 2 },
    ]);

    const out = loadThreadHistory("demo-google-ads", "thread-abc");

    expect(loadSessionHistoryMock).toHaveBeenCalledWith(
      "demo-google-ads",
      "internal-xyz",
    );
    expect(loadSessionHistoryMock).not.toHaveBeenCalledWith(
      "demo-google-ads",
      "thread-abc",
    );
    expect(out.sessionKey).toBe("agent:demo-google-ads:thread-abc");
    expect(out.history).toHaveLength(2);
  });

  it("returns pending sessionKey + empty history when threadId is unknown to OpenClaw", () => {
    // First open of a freshly-minted thread — OpenClaw hasn't seen it
    // yet, so findSessionBySessionId returns null. Caller should treat
    // as pending (no history, sessionKey is a fresh pending one).
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    const out = loadThreadHistory("demo-google-ads", "fresh-thread");
    expect(out.history).toEqual([]);
    expect(out.sessionKey).toBe("agent:demo-google-ads:fresh-thread");
    expect(loadSessionHistoryMock).not.toHaveBeenCalled();
  });
});

describe("shouldAutoKickoffTask", () => {
  it("fires for proposed task with empty history (happy path)", () => {
    expect(shouldAutoKickoffTask({ ...baseTask, status: "proposed" }, [])).toBe(true);
  });

  it("does NOT fire for proposed task with existing history (resume case)", () => {
    expect(
      shouldAutoKickoffTask({ ...baseTask, status: "proposed" }, [
        { id: "0", role: "user", body: "...", timestamp: 1 },
      ]),
    ).toBe(false);
  });

  it("does NOT fire for succeeded task even with empty history (REGRESSION — task re-trigger bug)", () => {
    // The bug the user reported: clicking a succeeded task re-triggered
    // the agent. Root cause was loadThreadHistory returning [] (separate
    // bug, fixed above). This guard is defense-in-depth so even if
    // history loading regresses again, a succeeded task never re-runs.
    expect(shouldAutoKickoffTask({ ...baseTask, status: "succeeded" }, [])).toBe(false);
  });

  it("does NOT fire for running task (agent is already at work — or stalled, user retries explicitly)", () => {
    expect(shouldAutoKickoffTask({ ...baseTask, status: "running" }, [])).toBe(false);
  });

  it("does NOT fire for failed task (no implicit auto-retry; user must explicitly restart)", () => {
    expect(shouldAutoKickoffTask({ ...baseTask, status: "failed" }, [])).toBe(false);
  });

  it("does NOT fire for cancelled task", () => {
    expect(shouldAutoKickoffTask({ ...baseTask, status: "cancelled" }, [])).toBe(false);
  });

  it("does NOT fire for approved task (in v1.1 the post-approval kickoff will be triggered explicitly)", () => {
    expect(shouldAutoKickoffTask({ ...baseTask, status: "approved" }, [])).toBe(false);
  });
});

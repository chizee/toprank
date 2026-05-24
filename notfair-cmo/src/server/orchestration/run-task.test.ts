import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/types";

// --- Module mocks (must be set up before importing the SUT). ---

const claimProposedTaskMock = vi.fn();
const setTaskThreadIfMissingMock = vi.fn();
const updateTaskMock = vi.fn();
vi.mock("@/server/db/tasks", () => ({
  claimProposedTask: (...a: unknown[]) => claimProposedTaskMock(...a),
  setTaskThreadIfMissing: (...a: unknown[]) => setTaskThreadIfMissingMock(...a),
  updateTask: (...a: unknown[]) => updateTaskMock(...a),
}));

const streamChatViaGatewayMock = vi.fn();
vi.mock("@/server/openclaw/gateway-client", () => ({
  streamChatViaGateway: (...a: unknown[]) => streamChatViaGatewayMock(...a),
}));

vi.mock("@/server/openclaw/sessions", () => ({
  buildPendingSessionKey: (agent: string, thread: string) =>
    `agent:${agent}:${thread}`,
}));

// Shadow transcript writes to ~/.notfair-cmo by default — stub to keep
// the unit test isolated from disk. Functional behavior is covered by
// the e2e browser test.
vi.mock("@/server/openclaw/shadow-transcript", () => ({
  openShadowWriter: async () => ({
    appendDelta: () => {},
    flushAssistant: async () => {},
    toolStart: async () => {},
    toolResult: async () => {},
    close: async () => {},
  }),
  shadowStreamEvent: async () => {},
}));

// generateTaskThreadId lives on task-kickoff now. Mock just that one symbol
// while letting the real buildTaskKickoffMessage run — we want to catch
// contract drift between run-task and the kickoff format.
const generateTaskThreadIdMock = vi.fn(() => "thread-fresh");
vi.mock("./task-kickoff", async () => {
  const actual =
    await vi.importActual<typeof import("./task-kickoff")>("./task-kickoff");
  return {
    ...actual,
    generateTaskThreadId: () => generateTaskThreadIdMock(),
  };
});

import { runTaskKickoffServerSide, startTaskIfProposed } from "./run-task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    display_id: "demo-1",
    project_slug: "demo",
    agent_id: "demo-google-ads",
    title: "Install conversion tracking",
    brief: "Add the Google Ads conversion tag.",
    success_criteria: "Tag fires on /thanks; conv appears in Google Ads.",
    deadline_iso: null,
    status: "proposed",
    result_json: null,
    error_message: null,
    thread_id: "thread-existing",
    assigner_agent_id: "demo-cmo",
    blocked_by_task_id: null,
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
    ...overrides,
  };
}

// Helper: build an async-iterable matching the StreamChatInput contract.
async function* eventStream(
  events: Array<{ kind: "delta"; text: string } | { kind: "error"; message: string }>,
): AsyncGenerator<unknown, void, void> {
  for (const evt of events) yield evt;
}

describe("startTaskIfProposed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: streaming returns no text so the kickoff is a no-op past the
    // claim. Individual tests override.
    streamChatViaGatewayMock.mockImplementation(() => eventStream([]));
  });

  it("returns the input task untouched when the claim fails (already running)", () => {
    claimProposedTaskMock.mockReturnValue(null);
    const task = makeTask({ status: "working" });
    const result = startTaskIfProposed(task);
    expect(result).toBe(task);
    // Kickoff must not be triggered when the claim doesn't succeed.
    expect(streamChatViaGatewayMock).not.toHaveBeenCalled();
  });

  it("returns the claimed task and fires kickoff in the background when claim succeeds", async () => {
    const claimed = makeTask({ status: "working" });
    claimProposedTaskMock.mockReturnValue(claimed);

    const result = startTaskIfProposed(makeTask({ status: "proposed" }));
    expect(result).toBe(claimed);
    expect(claimProposedTaskMock).toHaveBeenCalledWith("task-1");

    // The kickoff is fire-and-forget; let microtasks drain so it actually runs.
    await new Promise((r) => setImmediate(r));
    expect(streamChatViaGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("swallows kickoff errors so the caller (synchronous) never throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const claimed = makeTask({ status: "working", thread_id: null });
    claimProposedTaskMock.mockReturnValue(claimed);
    // Force the kickoff to throw — thread assignment will fail because both
    // claim + setTaskThreadIfMissing return null.
    setTaskThreadIfMissingMock.mockReturnValue(null);

    expect(() =>
      startTaskIfProposed(makeTask({ status: "proposed", thread_id: null })),
    ).not.toThrow();

    // Wait for the background error to surface via console.error.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalledWith(
      "[start-task] kickoff failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});

describe("runTaskKickoffServerSide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consumes the gateway stream and passes the kickoff message + session context", async () => {
    streamChatViaGatewayMock.mockImplementation(() =>
      eventStream([
        { kind: "delta", text: "On it." },
        { kind: "delta", text: " Wrapping up." },
      ]),
    );

    await runTaskKickoffServerSide(makeTask());

    expect(streamChatViaGatewayMock).toHaveBeenCalledTimes(1);
    const [call] = streamChatViaGatewayMock.mock.calls;
    expect(call?.[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:demo-google-ads:thread-existing",
        sessionId: "thread-existing",
        // The kickoff message is built by buildTaskKickoffMessage — sanity-check
        // it carries the brief without locking the prose to a snapshot.
        message: expect.stringContaining("Add the Google Ads conversion tag."),
      }),
    );
    expect(call?.[0].message).toContain("task_id:      task-1");

    // run-task no longer post-processes the buffer — side effects now happen
    // via MCP tool calls during the stream.
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("lazily assigns a fresh thread_id when the task has none yet", async () => {
    const refreshed = makeTask({ thread_id: "thread-fresh" });
    setTaskThreadIfMissingMock.mockReturnValue(refreshed);
    streamChatViaGatewayMock.mockImplementation(() => eventStream([]));

    await runTaskKickoffServerSide(makeTask({ thread_id: null }));

    expect(setTaskThreadIfMissingMock).toHaveBeenCalledWith(
      "task-1",
      "thread-fresh",
    );
    expect(streamChatViaGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "thread-fresh",
        sessionKey: "agent:demo-google-ads:thread-fresh",
      }),
    );
  });

  it("throws when no thread_id can be assigned (and does not call the gateway)", async () => {
    setTaskThreadIfMissingMock.mockReturnValue(null);
    await expect(
      runTaskKickoffServerSide(makeTask({ thread_id: null })),
    ).rejects.toThrow(/Failed to assign thread_id/);
    expect(streamChatViaGatewayMock).not.toHaveBeenCalled();
  });

  it("on gateway error event: marks task failed with the gateway's message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    streamChatViaGatewayMock.mockImplementation(() =>
      eventStream([
        { kind: "delta", text: "partial..." },
        { kind: "error", message: "gateway exploded" },
      ]),
    );

    await runTaskKickoffServerSide(makeTask());

    expect(updateTaskMock).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error_message: "gateway exploded",
      }),
    );
    errSpy.mockRestore();
  });

  it("on gateway iterator throw: marks task failed with the thrown message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    streamChatViaGatewayMock.mockImplementation(async function* () {
      yield { kind: "delta", text: "starting..." };
      throw new Error("socket closed");
    });

    await runTaskKickoffServerSide(makeTask());

    expect(updateTaskMock).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error_message: "socket closed",
      }),
    );
    errSpy.mockRestore();
  });

  it("on non-Error throw from gateway: stringifies the value into error_message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    streamChatViaGatewayMock.mockImplementation(async function* () {
      // Some libraries reject with non-Error sentinels (e.g. plain strings).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string-reason";
      yield { kind: "delta", text: "" }; // keep async generator type happy
    });

    await runTaskKickoffServerSide(makeTask());

    expect(updateTaskMock).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error_message: "string-reason",
      }),
    );
    errSpy.mockRestore();
  });

  it("no-ops cleanly when the stream is blank (no failure update)", async () => {
    streamChatViaGatewayMock.mockImplementation(() =>
      eventStream([
        { kind: "delta", text: "   " },
        { kind: "delta", text: "\n\n" },
      ]),
    );
    await runTaskKickoffServerSide(makeTask());
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("keeps the existing thread_id when the task already has one (no lazy mint)", async () => {
    streamChatViaGatewayMock.mockImplementation(() => eventStream([]));
    await runTaskKickoffServerSide(makeTask({ thread_id: "thread-existing" }));
    expect(setTaskThreadIfMissingMock).not.toHaveBeenCalled();
    expect(streamChatViaGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "thread-existing" }),
    );
  });
});

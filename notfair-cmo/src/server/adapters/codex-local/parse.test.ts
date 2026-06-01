import { describe, expect, it } from "vitest";
import { makeCodexStreamState, parseCodexLine } from "./parse";

describe("parseCodexLine", () => {
  it("ignores blank and malformed lines", () => {
    const state = makeCodexStreamState();
    expect(parseCodexLine("", state)).toEqual([]);
    expect(parseCodexLine("not json", state)).toEqual([]);
  });

  it("captures the thread id on thread.started and emits a session event", () => {
    const state = makeCodexStreamState();
    const out = parseCodexLine(
      JSON.stringify({ type: "thread.started", thread_id: "abc-123" }),
      state,
    );
    expect(out).toEqual([
      { kind: "lifecycle", phase: "start" },
      { kind: "session", harnessSessionId: "abc-123" },
    ]);
    expect(state.threadId).toBe("abc-123");
  });

  it("emits a tool start event on item.started for a command_execution", () => {
    const state = makeCodexStreamState();
    const out = parseCodexLine(
      JSON.stringify({
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd_1",
          command: "ls -la\nsecond line",
        },
      }),
      state,
    );
    expect(out).toEqual([
      {
        kind: "tool",
        phase: "start",
        toolCallId: "cmd_1",
        name: "ls -la",
        label: "ls -la",
      },
    ]);
  });

  it("emits a delta when an agent_message item completes", () => {
    const state = makeCodexStreamState();
    const out = parseCodexLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Sure thing." },
      }),
      state,
    );
    expect(out).toEqual([{ kind: "delta", text: "Sure thing." }]);
    expect(state.assistantText).toBe("Sure thing.");
  });

  it("marks the turn finalized on turn.completed", () => {
    const state = makeCodexStreamState();
    state.assistantText = "Done";
    state.emittedTextLen = 4;
    const out = parseCodexLine(
      JSON.stringify({ type: "turn.completed", usage: {} }),
      state,
    );
    expect(out).toEqual([{ kind: "final", text: "Done" }]);
    expect(state.finalized).toBe(true);
  });

  it("emits an error event on turn.failed", () => {
    const state = makeCodexStreamState();
    const out = parseCodexLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "rate limit hit" },
      }),
      state,
    );
    expect(out).toEqual([{ kind: "error", message: "rate limit hit" }]);
    expect(state.finalized).toBe(true);
  });
});

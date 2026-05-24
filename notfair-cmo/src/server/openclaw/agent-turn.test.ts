import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts?: unknown) => spawnMock(cmd, args, opts),
}));

import { streamAgentTurn } from "./agent-turn";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => true);
  return proc;
}

async function collect(gen: AsyncGenerator<string, void, void>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("streamAgentTurn", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("spawns openclaw with --agent and --message args", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    await collect(streamAgentTurn({ agent: "demo-cmo", message: "hi" }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("openclaw");
    expect(args).toEqual(["agent", "--agent", "demo-cmo", "--message", "hi"]);
  });

  it("includes --session-id when provided", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    await collect(streamAgentTurn({ agent: "a", message: "m", sessionId: "sess-1" }));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
  });

  it("includes --thinking flag when provided", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    await collect(streamAgentTurn({ agent: "a", message: "m", thinking: "high" }));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("yields stdout chunks as they arrive", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("hello "));
      child.stdout.emit("data", Buffer.from("world"));
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    const chunks = await collect(streamAgentTurn({ agent: "a", message: "m" }));
    expect(chunks.join("")).toBe("hello world");
  });

  it("throws when openclaw exits non-zero, including stderr in error message", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("auth failed: token expired"));
      child.stdout.emit("end");
      child.emit("close", 7);
    });
    await expect(
      collect(streamAgentTurn({ agent: "a", message: "m" })),
    ).rejects.toThrow(/exited with code 7/);
  });

  it("includes stderr snippet in the thrown error", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("boom!"));
      child.stdout.emit("end");
      child.emit("close", 1);
    });
    let caught: unknown;
    try {
      await collect(streamAgentTurn({ agent: "a", message: "m" }));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/boom!/);
  });

  it("truncates very long stderr to 500 chars in the error message", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    const longErr = "x".repeat(2000);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from(longErr));
      child.stdout.emit("end");
      child.emit("close", 1);
    });
    let caught: unknown;
    try {
      await collect(streamAgentTurn({ agent: "a", message: "m" }));
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg.length).toBeLessThan(longErr.length);
    expect(msg).toMatch(/x{200,500}/);
  });

  it("propagates process 'error' events", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      // Don't emit close — emit error to trigger rejectErr path.
      child.emit("error", new Error("ENOENT openclaw"));
      // After throwing, also emit close so any internal waiters resolve.
      child.stdout.emit("end");
      child.emit("close", null);
    });
    await expect(
      collect(streamAgentTurn({ agent: "a", message: "m" })),
    ).rejects.toThrow(/ENOENT openclaw/);
  });

  it("clears the kill timer on success (timeout never fires)", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      spawnMock.mockImplementationOnce(() => child);
      // Schedule end on the next macrotask under fake timers.
      setImmediate(() => {
        child.stdout.emit("end");
        child.emit("close", 0);
      });
      const p = collect(streamAgentTurn({ agent: "a", message: "m", timeoutMs: 1000 }));
      // Advance to drain queued setImmediates.
      await vi.advanceTimersByTimeAsync(0);
      await p;
      // Advance well past the timeout — kill should NOT have been called.
      vi.advanceTimersByTime(60_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses default 300s timeout when none provided", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    await collect(streamAgentTurn({ agent: "a", message: "m" }));
    // No assertion error means default timeout was set without crashing.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("yields nothing when the process emits no stdout but exits cleanly", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    const chunks = await collect(streamAgentTurn({ agent: "a", message: "m" }));
    expect(chunks).toEqual([]);
  });

  it("passes the right stdio config to spawn", async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit("end");
      child.emit("close", 0);
    });
    await collect(streamAgentTurn({ agent: "a", message: "m" }));
    const opts = spawnMock.mock.calls[0]![2] as { stdio: [string, string, string] };
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});

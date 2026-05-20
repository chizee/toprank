import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so we don't actually spawn binaries in tests.
// Each test sets up its own queue of fake spawn results.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => spawnMock(cmd, args),
}));

import { OpenClawError, openclaw } from "./cli";

type SpawnResult = {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
};

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => boolean;
};

/**
 * Plain EventEmitters for stdout/stderr + the process itself — that's all
 * the cli.ts implementation listens to (`.on("data")` + `.on("close")`).
 * Schedule emits with setImmediate so the cli's listeners are guaranteed
 * to be attached before any event fires.
 */
function fakeChild({ stdout = "", stderr = "", exitCode }: SpawnResult): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => true;
  setImmediate(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  });
  return proc;
}

describe("openclaw cli", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  describe("happy path", () => {
    it("returns parsed JSON on a successful run", async () => {
      spawnMock.mockImplementationOnce(() =>
        fakeChild({ stdout: '{"ok":true,"name":"demo"}', exitCode: 0 }),
      );
      const out = await openclaw(["mcp", "list"]);
      expect(out).toEqual({ ok: true, name: "demo" });
    });

    it("returns raw stdout when json:false", async () => {
      spawnMock.mockImplementationOnce(() => fakeChild({ stdout: "plain text\n", exitCode: 0 }));
      const out = await openclaw(["health"], { json: false });
      expect(out).toBe("plain text\n");
    });

    it("appends --json by default when not already present", async () => {
      spawnMock.mockImplementationOnce(() => fakeChild({ stdout: "{}", exitCode: 0 }));
      await openclaw(["agents", "list"]);
      expect(spawnMock).toHaveBeenCalledWith(
        "openclaw",
        ["agents", "list", "--json"],
      );
    });

    it("does NOT append --json when json:false", async () => {
      spawnMock.mockImplementationOnce(() => fakeChild({ stdout: "", exitCode: 0 }));
      await openclaw(["mcp", "unset", "demo-foo"], { json: false });
      expect(spawnMock).toHaveBeenCalledWith(
        "openclaw",
        ["mcp", "unset", "demo-foo"],
      );
    });
  });

  describe("error reporting", () => {
    it("rejects with OpenClawError that includes stderr in the message", async () => {
      spawnMock.mockImplementationOnce(() =>
        fakeChild({
          stderr:
            "[openclaw] Could not start the CLI. [openclaw] Reason: bad config",
          exitCode: 1,
        }),
      );
      let caught: unknown;
      try {
        await openclaw(["mcp", "set", "bad"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OpenClawError);
      const err = caught as OpenClawError;
      expect(err.exitCode).toBe(1);
      expect(err.stderr).toMatch(/Reason: bad config/);
      // The user-visible message must include the stderr snippet so the
      // OAuth callback can render it without separate plumbing.
      expect(err.message).toMatch(/exited with code 1/);
      expect(err.message).toMatch(/Reason: bad config/);
    });

    it("rejects with OpenClawError when stdout is not valid JSON", async () => {
      spawnMock.mockImplementationOnce(() =>
        fakeChild({ stdout: "<not json>", exitCode: 0 }),
      );
      let caught: unknown;
      try {
        await openclaw(["mcp", "list"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OpenClawError);
      expect((caught as OpenClawError).message).toMatch(/not valid JSON/);
    });

    it("truncates very long stderr to 240 chars in the message", async () => {
      const longStderr = "x".repeat(500);
      spawnMock.mockImplementationOnce(() =>
        fakeChild({ stderr: longStderr, exitCode: 1 }),
      );
      let caught: unknown;
      try {
        await openclaw(["foo"]);
      } catch (err) {
        caught = err;
      }
      const msg = (caught as OpenClawError).message;
      // Message has the base "exited with code N: " plus up to 240 stderr chars.
      // Full stderr ("x" × 500) is still stored on the error object for logs.
      expect((caught as OpenClawError).stderr).toBe(longStderr);
      expect(msg.length).toBeLessThan(longStderr.length);
      expect(msg).toMatch(/x{200,240}/);
    });
  });

  describe('retry on "config changed since last load"', () => {
    it("retries up to 3 times and succeeds when a later attempt wins", async () => {
      // First two attempts hit the cross-process race; third one writes
      // cleanly. The mock returns a fresh child per call, simulating
      // sequential CLI invocations.
      spawnMock
        .mockImplementationOnce(() =>
          fakeChild({
            stderr: "[openclaw] Reason: config changed since last load",
            exitCode: 1,
          }),
        )
        .mockImplementationOnce(() =>
          fakeChild({
            stderr: "[openclaw] Reason: config changed since last load",
            exitCode: 1,
          }),
        )
        .mockImplementationOnce(() => fakeChild({ stdout: '{"ok":true}', exitCode: 0 }));

      const out = await openclaw(["mcp", "set", "demo-foo", "{}"]);
      expect(out).toEqual({ ok: true });
      expect(spawnMock).toHaveBeenCalledTimes(3);
    });

    it("retries on EAGAIN / EBUSY (other transient writes against openclaw.json)", async () => {
      spawnMock
        .mockImplementationOnce(() =>
          fakeChild({ stderr: "open EAGAIN at /Users/x/.openclaw/openclaw.json", exitCode: 1 }),
        )
        .mockImplementationOnce(() => fakeChild({ stdout: '{"ok":true}', exitCode: 0 }));

      const out = await openclaw(["mcp", "set", "demo-foo", "{}"]);
      expect(out).toEqual({ ok: true });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry when stderr doesn't match the transient pattern", async () => {
      spawnMock.mockImplementationOnce(() =>
        fakeChild({ stderr: "permission denied", exitCode: 1 }),
      );
      await expect(openclaw(["foo"])).rejects.toThrow(/permission denied/);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("gives up after maxAttempts when the race never resolves", async () => {
      const transient = {
        stderr: "[openclaw] Reason: config changed since last load",
        exitCode: 1,
      } as const;
      spawnMock
        .mockImplementationOnce(() => fakeChild(transient))
        .mockImplementationOnce(() => fakeChild(transient))
        .mockImplementationOnce(() => fakeChild(transient));

      await expect(openclaw(["mcp", "set", "demo-foo", "{}"])).rejects.toThrow(
        /config changed since last load/,
      );
      expect(spawnMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("in-process serialization", () => {
    it("serializes concurrent calls — second waits for first to finish", async () => {
      // The mutex should hold p2's spawn until p1 has emitted its close.
      // We give p1 a deferred close (controlled by `releaseFirst`) so
      // we can probe the queue mid-flight; p2 uses the normal fakeChild
      // that auto-closes once released.
      const callOrder: number[] = [];
      let releaseFirst!: () => void;

      spawnMock
        .mockImplementationOnce(() => {
          callOrder.push(1);
          const proc = new EventEmitter() as FakeChild;
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.kill = () => true;
          releaseFirst = () => {
            proc.stdout.emit("data", Buffer.from('{"id":1}'));
            proc.emit("close", 0);
          };
          return proc;
        })
        .mockImplementationOnce(() => {
          callOrder.push(2);
          return fakeChild({ stdout: '{"id":2}', exitCode: 0 });
        });

      const p1 = openclaw(["a"]);
      const p2 = openclaw(["b"]);

      // Let microtasks + setImmediates drain — first spawn should have
      // happened, second should be still queued behind p1.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(callOrder).toEqual([1]);

      releaseFirst();
      await expect(p1).resolves.toEqual({ id: 1 });
      await expect(p2).resolves.toEqual({ id: 2 });
      expect(callOrder).toEqual([1, 2]);
    });

    it("a failing call doesn't poison the queue — next call still runs", async () => {
      spawnMock
        .mockImplementationOnce(() => fakeChild({ stderr: "permanent failure", exitCode: 1 }))
        .mockImplementationOnce(() => fakeChild({ stdout: '{"ok":true}', exitCode: 0 }));

      const failing = openclaw(["a"]);
      const succeeding = openclaw(["b"]);

      await expect(failing).rejects.toThrow();
      // Without the `.catch` on the queue tail, this would never resolve.
      await expect(succeeding).resolves.toEqual({ ok: true });
    });
  });
});

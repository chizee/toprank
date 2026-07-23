import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveCodexBinary: vi.fn(() => "codex"),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./binary", () => ({
  resolveCodexBinary: mocks.resolveCodexBinary,
}));

import { testCodexLocalEnvironment } from "./test";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

function scriptVersionCmd(script: {
  stdout?: string;
  exitCode?: number;
  spawnError?: boolean;
  hang?: boolean;
}): FakeChild {
  const child = new FakeChild();
  mocks.spawn.mockImplementationOnce(() => {
    if (!script.hang) {
      setImmediate(() => {
        if (script.spawnError) {
          child.emit("error", new Error("ENOENT"));
          return;
        }
        if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
        child.emit("close", script.exitCode ?? 0);
      });
    }
    return child;
  });
  return child;
}

beforeEach(() => mocks.spawn.mockReset());
afterEach(() => vi.useRealTimers());

describe("testCodexLocalEnvironment", () => {
  it("reports ok with a parsed version label when the CLI responds", async () => {
    scriptVersionCmd({ stdout: "codex-cli 0.144.2\n" });
    const health = await testCodexLocalEnvironment();
    expect(health).toEqual({
      ok: true,
      auth: "unknown",
      versionLabel: "Codex 0.144.2",
    });
    expect(mocks.spawn).toHaveBeenCalledWith("codex", ["--version"], expect.anything());
  });

  it("falls back to a bare label when the version string is unparsable", async () => {
    scriptVersionCmd({ stdout: "nightly\n" });
    const health = await testCodexLocalEnvironment();
    expect(health.versionLabel).toBe("Codex");
  });

  it("reports not-ok with an install hint when the binary is missing", async () => {
    scriptVersionCmd({ spawnError: true });
    const health = await testCodexLocalEnvironment();
    expect(health.ok).toBe(false);
    expect(health.message).toContain("Codex CLI check failed for `codex`");
  });

  it("times out a hung probe instead of waiting forever", async () => {
    vi.useFakeTimers();
    const child = scriptVersionCmd({ hang: true });
    const pending = testCodexLocalEnvironment();
    await vi.advanceTimersByTimeAsync(5_001);
    const health = await pending;
    expect(health.ok).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

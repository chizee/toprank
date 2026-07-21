import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
    rmSync: mocks.rmSync,
    mkdirSync: mocks.mkdirSync,
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  buildChromeLaunchArgs,
  clearChromeSingletonArtifacts,
  findChromeExecutable,
  launchChrome,
  stopChrome,
  waitForCdpReady,
} from "./chrome";

function child() {
  const events = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = events as EventEmitter & {
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => true);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
  mocks.rmSync.mockReturnValue(undefined);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Chrome discovery and args", () => {
  it("prefers a valid explicit path", () => {
    const exists = vi.fn((p: string) => p === "/custom/chrome");
    expect(findChromeExecutable({ NOTFAIR_CHROME_PATH: " /custom/chrome " }, "darwin", exists)).toBe("/custom/chrome");
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it("falls back to platform candidates and returns null on unsupported platforms", () => {
    const exists = vi.fn((p: string) => p.includes("Chromium.app"));
    expect(findChromeExecutable({}, "darwin", exists)).toContain("Chromium.app");
    expect(findChromeExecutable({}, "win32", exists)).toBeNull();
    expect(findChromeExecutable({ NOTFAIR_CHROME_PATH: "/missing" }, "linux", () => false)).toBeNull();
  });

  it("builds headed/headless platform-specific args", () => {
    const base = buildChromeLaunchArgs({ executablePath: "chrome", userDataDir: "/profile", cdpPort: 9222, platform: "darwin" });
    expect(base).toContain("--remote-debugging-port=9222");
    expect(base).not.toContain("--headless=new");
    const linux = buildChromeLaunchArgs({
      executablePath: "chrome",
      userDataDir: "/profile",
      cdpPort: 9222,
      platform: "linux",
      headless: true,
      extraArgs: ["--proxy-server=x"],
    });
    expect(linux).toEqual(expect.arrayContaining(["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--proxy-server=x"]));
  });

  it("removes every singleton artifact and tolerates failures", () => {
    mocks.rmSync.mockImplementationOnce(() => { throw new Error("locked"); });
    expect(() => clearChromeSingletonArtifacts("/profile")).not.toThrow();
    expect(mocks.rmSync).toHaveBeenCalledTimes(3);
    expect(mocks.rmSync).toHaveBeenCalledWith("/profile/SingletonSocket", { force: true });
  });
});

describe("CDP readiness and lifecycle", () => {
  it("returns as soon as the endpoint is ready", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    await expect(waitForCdpReady("http://cdp", 100)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("http://cdp/json/version", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("includes the last HTTP or network error when timing out", async () => {
    await expect(waitForCdpReady("http://cdp", 0)).rejects.toThrow(/did not become ready/);
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(waitForCdpReady("http://cdp", 2, 0)).rejects.toThrow(/status 503/);
    vi.mocked(fetch).mockRejectedValue(new Error("refused"));
    await expect(waitForCdpReady("http://cdp", 2, 0)).rejects.toThrow(/refused/);
  });

  it("launches Chrome and returns its CDP metadata", async () => {
    const proc = child();
    mocks.spawn.mockReturnValue(proc);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const launched = await launchChrome({
      executablePath: "/chrome",
      userDataDir: "/profile",
      cdpPort: 9333,
      platform: "darwin",
    });
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/profile", { recursive: true });
    expect(mocks.spawn).toHaveBeenCalledWith("/chrome", expect.arrayContaining(["--remote-debugging-port=9333"]), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    expect(launched).toMatchObject({ cdpPort: 9333, cdpHttpUrl: "http://127.0.0.1:9333", userDataDir: "/profile" });
  });

  it("kills Chrome and surfaces an early exit with stderr tail", async () => {
    const proc = child();
    mocks.spawn.mockReturnValue(proc);
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const promise = launchChrome({ executablePath: "/chrome", userDataDir: "/profile", cdpPort: 9444 });
    proc.stderr.emit("data", Buffer.from("startup failed"));
    proc.emit("exit", 2, "SIGABRT");
    await expect(promise).rejects.toThrow(/code=2.*startup failed/);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("stops an already-exited process with cleanup only", async () => {
    const proc = child();
    proc.exitCode = 0;
    await stopChrome({ process: proc as never, cdpPort: 1, cdpHttpUrl: "x", userDataDir: "/profile" });
    expect(proc.kill).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledTimes(3);
  });

  it("uses SIGTERM for a live process that exits promptly", async () => {
    const proc = child();
    proc.kill.mockImplementation((signal: string) => {
      if (signal === "SIGTERM") queueMicrotask(() => { proc.exitCode = 0; proc.emit("exit", 0, null); });
      return true;
    });
    await stopChrome({ process: proc as never, cdpPort: 1, cdpHttpUrl: "x", userDataDir: "/profile" }, 50);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back to SIGKILL after the graceful timeout", async () => {
    vi.useFakeTimers();
    const proc = child();
    proc.kill.mockImplementation((signal: string) => {
      if (signal === "SIGKILL") queueMicrotask(() => { proc.exitCode = 1; proc.emit("exit", 1, signal); });
      return true;
    });
    const promise = stopChrome({ process: proc as never, cdpPort: 1, cdpHttpUrl: "x", userDataDir: "/profile" }, 10);
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});

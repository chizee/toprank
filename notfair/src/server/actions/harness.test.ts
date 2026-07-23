import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  homedir: vi.fn(() => "/home/user"),
  spawn: vi.fn(),
  refreshUsage: vi.fn(),
  resolveCodexBinary: vi.fn(() => "codex"),
}));

vi.mock("node:os", () => ({ default: { homedir: mocks.homedir } }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/server/harness-usage", () => ({ refreshHarnessUsage: mocks.refreshUsage }));
vi.mock("@/server/adapters/codex-local/binary", () => ({
  resolveCodexBinary: mocks.resolveCodexBinary,
}));

import { refreshCodexUsageAction, startCodexLoginAction } from "./harness";

function child() {
  const proc = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  proc.unref = vi.fn();
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refreshUsage.mockResolvedValue({ kind: "codex", auth: "signed-out" });
});

it.each(["signed-in", "expired"])("does not spawn when auth is %s", async (auth) => {
  mocks.refreshUsage.mockResolvedValue({ kind: "codex", auth });
  await expect(startCodexLoginAction()).resolves.toEqual({ ok: true, alreadySignedIn: true });
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each([{ kind: "claude", auth: "signed-in" }, { kind: "codex", auth: "unknown" }])("starts detached login for %#", async (usage) => {
  mocks.refreshUsage.mockResolvedValue(usage);
  const proc = child();
  mocks.spawn.mockReturnValue(proc);
  const promise = startCodexLoginAction();
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  proc.emit("spawn");
  await expect(promise).resolves.toEqual({ ok: true, alreadySignedIn: false });
  expect(mocks.spawn).toHaveBeenCalledWith("codex", ["login"], expect.objectContaining({ cwd: "/home/user", detached: true, stdio: "ignore" }));
  expect(proc.unref).toHaveBeenCalled();
});

it("maps spawn errors and synchronous throws", async () => {
  let proc = child();
  mocks.spawn.mockReturnValue(proc);
  let promise = startCodexLoginAction();
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  proc.emit("error", new Error("denied"));
  await expect(promise).resolves.toEqual({ ok: false, error: "denied" });

  mocks.spawn.mockImplementation(() => { throw "no binary"; });
  await expect(startCodexLoginAction()).resolves.toEqual({ ok: false, error: "no binary" });
});

it("refreshes Codex usage", async () => {
  const usage = { kind: "codex", auth: "signed-in" };
  mocks.refreshUsage.mockResolvedValue(usage);
  await expect(refreshCodexUsageAction()).resolves.toBe(usage);
  expect(mocks.refreshUsage).toHaveBeenCalledWith("codex-local");
});

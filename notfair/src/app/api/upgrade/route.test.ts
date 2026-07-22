import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/server/version", () => ({
  _resetLatestCache: vi.fn(),
  getCurrentVersion: vi.fn(() => "0.9.7"),
  getLatestVersion: vi.fn(async () => "0.9.8"),
}));

import { POST, syncInstalledNativeBindings } from "./route";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("POST /api/upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts npm from the stable home directory instead of the server cwd", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const responsePromise = POST();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "npm",
      ["i", "-g", "notfair@latest"],
      expect.objectContaining({ cwd: homedir() }),
    );

    child.emit("exit", 7);
    const response = await responsePromise;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "npm exited with code 7",
    });
  });

  it("replaces standalone native bindings with npm's runtime-compatible copy", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "notfair-upgrade-"));
    const runtimeDir = join(packageRoot, "node_modules", "better-sqlite3", "build", "Release");
    const tracedDir = join(
      packageRoot,
      ".next",
      "standalone",
      ".next",
      "node_modules",
      "better-sqlite3-build-copy",
      "build",
      "Release",
    );
    const nestedDir = join(
      packageRoot,
      ".next",
      "standalone",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
    );

    try {
      await Promise.all([
        mkdir(runtimeDir, { recursive: true }),
        mkdir(tracedDir, { recursive: true }),
        mkdir(nestedDir, { recursive: true }),
      ]);
      await writeFile(join(runtimeDir, "better_sqlite3.node"), "node-25-binding");
      await Promise.all([
        writeFile(join(tracedDir, "better_sqlite3.node"), "node-24-binding"),
        writeFile(join(nestedDir, "better_sqlite3.node"), "node-24-binding"),
      ]);

      await expect(syncInstalledNativeBindings(packageRoot)).resolves.toBe(2);
      await expect(readFile(join(tracedDir, "better_sqlite3.node"), "utf8")).resolves.toBe(
        "node-25-binding",
      );
      await expect(readFile(join(nestedDir, "better_sqlite3.node"), "utf8")).resolves.toBe(
        "node-25-binding",
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
});

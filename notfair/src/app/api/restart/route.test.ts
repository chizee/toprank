import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { POST } from "./route";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
  };
  child.stdout = new EventEmitter();
  return child;
}

describe("POST /api/restart", () => {
  const originalManaged = process.env.NOTFAIR_MANAGED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NOTFAIR_MANAGED = "daemon";
  });

  afterEach(() => {
    if (originalManaged === undefined) {
      delete process.env.NOTFAIR_MANAGED;
    } else {
      process.env.NOTFAIR_MANAGED = originalManaged;
    }
  });

  it("looks up the global CLI from the stable home directory", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const responsePromise = POST();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "npm",
      ["root", "-g"],
      expect.objectContaining({ cwd: homedir() }),
    );

    child.emit("close", 1);
    const response = await responsePromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Could not locate the globally-installed notfair CLI.",
    });
  });
});

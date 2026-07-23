import { describe, expect, it, vi } from "vitest";
import { resolveCodexBinary } from "./binary";

describe("resolveCodexBinary", () => {
  it("honors an explicit executable override", () => {
    const isExecutable = vi.fn();

    expect(
      resolveCodexBinary({
        env: {
          NOTFAIR_CODEX_BIN: "  /custom/codex-nightly  ",
          PATH: "/bin",
        },
        isExecutable,
      }),
    ).toBe("/custom/codex-nightly");
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it("prefers an executable already present on PATH", () => {
    expect(
      resolveCodexBinary({
        env: { PATH: "/managed/bin:/usr/bin" },
        homeDir: "/Users/tester",
        platform: "darwin",
        isExecutable: (candidate) => candidate === "/managed/bin/codex",
      }),
    ).toBe("/managed/bin/codex");
  });

  it("finds the Codex executable bundled with ChatGPT on macOS", () => {
    expect(
      resolveCodexBinary({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: "/Users/tester",
        platform: "darwin",
        isExecutable: (candidate) =>
          candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    ).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
  });

  it("checks a user-local ChatGPT installation", () => {
    expect(
      resolveCodexBinary({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: "/Users/tester",
        platform: "darwin",
        isExecutable: (candidate) =>
          candidate ===
          "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    ).toBe(
      "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex",
    );
  });

  it("falls back to the command name so spawn can report the final error", () => {
    expect(
      resolveCodexBinary({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: "/home/tester",
        platform: "linux",
        isExecutable: () => false,
      }),
    ).toBe("codex");
  });
});

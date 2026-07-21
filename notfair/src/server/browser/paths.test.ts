import { describe, expect, it, vi } from "vitest";

// Point NOTFAIR_DATA_DIR at a tmpdir before importing the module under test.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-paths-"));
});

import {
  CDP_PORT_RANGE_START,
  CDP_PORT_RANGE_END,
  allocateCdpPort,
  isValidProjectSlug,
  notfairDataDir,
  resolveBrowserProfileDir,
  resolveUserDataDir,
} from "./paths";

describe("notfairDataDir", () => {
  it("uses NOTFAIR_DATA_DIR when set", () => {
    expect(notfairDataDir()).toBe(process.env.NOTFAIR_DATA_DIR);
  });

  it("falls back to ~/.notfair when unset", async () => {
    const saved = process.env.NOTFAIR_DATA_DIR;
    delete process.env.NOTFAIR_DATA_DIR;
    try {
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      expect(notfairDataDir()).toBe(join(homedir(), ".notfair"));
    } finally {
      process.env.NOTFAIR_DATA_DIR = saved;
    }
  });
});

describe("isValidProjectSlug", () => {
  it("accepts lowercase alphanumeric + hyphen slugs", () => {
    expect(isValidProjectSlug("proj")).toBe(true);
    expect(isValidProjectSlug("my-project-1")).toBe(true);
    expect(isValidProjectSlug("a")).toBe(true);
  });

  it("rejects empty, too-long, uppercase, leading-hyphen and invalid chars", () => {
    expect(isValidProjectSlug("")).toBe(false);
    expect(isValidProjectSlug("a".repeat(65))).toBe(false);
    expect(isValidProjectSlug("Proj")).toBe(false);
    expect(isValidProjectSlug("-proj")).toBe(false);
    expect(isValidProjectSlug("proj_x")).toBe(false);
    expect(isValidProjectSlug("proj space")).toBe(false);
  });

  it("accepts a 64-char slug (boundary)", () => {
    expect(isValidProjectSlug("a".repeat(64))).toBe(true);
  });
});

describe("resolveBrowserProfileDir / resolveUserDataDir", () => {
  it("builds paths under the data dir", () => {
    const dir = resolveBrowserProfileDir("proj");
    expect(dir).toContain("projects");
    expect(dir).toContain("proj");
    expect(dir.endsWith("browser")).toBe(true);
    expect(resolveUserDataDir("proj").endsWith("user-data")).toBe(true);
  });

  it("throws on an invalid slug", () => {
    expect(() => resolveBrowserProfileDir("BAD SLUG")).toThrow(/Invalid project slug/);
    expect(() => resolveUserDataDir("_bad")).toThrow(/Invalid project slug/);
  });
});

describe("allocateCdpPort", () => {
  it("is deterministic and within range", () => {
    const p1 = allocateCdpPort("proj");
    const p2 = allocateCdpPort("proj");
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThanOrEqual(CDP_PORT_RANGE_START);
    expect(p1).toBeLessThanOrEqual(CDP_PORT_RANGE_END);
  });

  it("throws on an invalid slug", () => {
    expect(() => allocateCdpPort("Bad")).toThrow(/Invalid project slug/);
  });

  it("maps different slugs across the range", () => {
    const ports = new Set(
      ["alpha", "beta", "gamma", "delta", "omega"].map(allocateCdpPort),
    );
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(CDP_PORT_RANGE_START);
      expect(p).toBeLessThanOrEqual(CDP_PORT_RANGE_END);
    }
  });
});

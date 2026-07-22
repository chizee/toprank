import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { syncStandaloneNativeBindings } from "../../bin/native-bindings.mjs";

describe("syncStandaloneNativeBindings", () => {
  it("refreshes release-built bindings before a fresh CLI start", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "notfair-cli-bindings-"));
    const runtimeDir = join(packageRoot, "node_modules", "better-sqlite3", "build", "Release");
    const tracedDir = join(
      packageRoot,
      ".next",
      "standalone",
      ".next",
      "node_modules",
      "better-sqlite3-traced",
      "build",
      "Release",
    );

    try {
      await Promise.all([
        mkdir(runtimeDir, { recursive: true }),
        mkdir(tracedDir, { recursive: true }),
      ]);
      await writeFile(join(runtimeDir, "better_sqlite3.node"), "local-node-binding");
      await writeFile(join(tracedDir, "better_sqlite3.node"), "release-node-binding");

      expect(syncStandaloneNativeBindings(packageRoot)).toBe(1);
      await expect(readFile(join(tracedDir, "better_sqlite3.node"), "utf8")).resolves.toBe(
        "local-node-binding",
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("is a no-op when npm did not install a runtime binding", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "notfair-cli-bindings-"));
    try {
      expect(syncStandaloneNativeBindings(packageRoot)).toBe(0);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
});

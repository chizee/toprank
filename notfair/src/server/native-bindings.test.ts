import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveCompatibleNodeRuntime,
  syncStandaloneNativeBindings,
} from "../../bin/native-bindings.mjs";

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

  it("uses the package prefix Node when the shell Node cannot load the installed binding", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "notfair-cli-runtime-"));
    const packageRoot = join(prefix, "lib", "node_modules", "notfair");
    const binding = join(
      packageRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    const shellNode = join(prefix, "shell", "node");
    const installedNode = join(prefix, "bin", "node");

    try {
      await Promise.all([
        mkdir(dirname(binding), { recursive: true }),
        mkdir(dirname(shellNode), { recursive: true }),
        mkdir(dirname(installedNode), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(binding, "node-25-binding"),
        writeFile(shellNode, "node-24"),
        writeFile(installedNode, "node-25"),
      ]);

      expect(
        resolveCompatibleNodeRuntime(packageRoot, {
          execPath: shellNode,
          probe: (candidate: string) => candidate === installedNode,
        }),
      ).toBe(installedNode);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });

  it("keeps the active Node when it can load the installed binding", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "notfair-cli-runtime-"));
    const packageRoot = join(prefix, "lib", "node_modules", "notfair");
    const binding = join(
      packageRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    const shellNode = join(prefix, "shell", "node");
    const probed: string[] = [];

    try {
      await Promise.all([
        mkdir(dirname(binding), { recursive: true }),
        mkdir(dirname(shellNode), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(binding, "node-25-binding"),
        writeFile(shellNode, "node-25"),
      ]);

      expect(
        resolveCompatibleNodeRuntime(packageRoot, {
          execPath: shellNode,
          probe: (candidate: string) => {
            probed.push(candidate);
            return candidate === shellNode;
          },
        }),
      ).toBe(shellNode);
      expect(probed).toEqual([shellNode]);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });

  it("fails with reinstall guidance when no available Node can load the binding", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "notfair-cli-runtime-"));
    const packageRoot = join(prefix, "lib", "node_modules", "notfair");
    const binding = join(
      packageRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    const shellNode = join(prefix, "shell", "node");
    const installedNode = join(prefix, "bin", "node");

    try {
      await Promise.all([
        mkdir(dirname(binding), { recursive: true }),
        mkdir(dirname(shellNode), { recursive: true }),
        mkdir(dirname(installedNode), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(binding, "node-25-binding"),
        writeFile(shellNode, "node-24"),
        writeFile(installedNode, "node-23"),
      ]);

      expect(() =>
        resolveCompatibleNodeRuntime(packageRoot, {
          execPath: shellNode,
          probe: () => false,
        }),
      ).toThrow("npm install -g notfair@latest");
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
});

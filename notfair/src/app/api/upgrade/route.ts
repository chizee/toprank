import { spawn } from "node:child_process";
import { copyFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

import { _resetLatestCache, getCurrentVersion, getLatestVersion } from "@/server/version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_BYTES = 4_000;

/**
 * POST /api/upgrade
 *
 * Runs `npm i -g notfair@latest` from the user's shell environment.
 * The currently-running NotFair process keeps the old code loaded in
 * memory (Node module cache), so the user must restart `notfair` to
 * pick up the upgraded binary. The response message says so.
 *
 * If npm isn't on PATH (e.g. the user runs NotFair from a node_modules
 * shim that doesn't expose npm globally), we surface the spawn error so
 * the client can show the copyable command instead.
 */
export async function POST() {
  // A running standalone bundle can be replaced by a source rebuild or by
  // the upgrade itself. Never let npm inherit that now-missing directory:
  // Node aborts in process.cwd() with ENOENT (`npm` exit code 7) before the
  // install even starts. The user's home directory is stable across both.
  return new Promise<Response>((resolve) => {
    const startedAt = Date.now();
    const child = spawn("npm", ["i", "-g", "notfair@latest"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: homedir(),
    });

    let stdout = "";
    let stderr = "";
    const append = (target: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "out") {
        stdout = (stdout + text).slice(-TAIL_BYTES);
      } else {
        stderr = (stderr + text).slice(-TAIL_BYTES);
      }
    };
    child.stdout?.on("data", append("out"));
    child.stderr?.on("data", append("err"));

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }, UPGRADE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve(
        NextResponse.json(
          {
            ok: false,
            error: err.message,
            hint:
              "Could not run `npm` from the NotFair process. Run `npm i -g notfair@latest` in your terminal instead.",
            command: "npm i -g notfair@latest",
          },
          { status: 500 },
        ),
      );
    });

    child.on("exit", async (code) => {
      clearTimeout(killTimer);
      const elapsed_ms = Date.now() - startedAt;
      if (code === 0) {
        try {
          await syncGlobalNativeBindings();
        } catch (error) {
          resolve(
            NextResponse.json(
              {
                ok: false,
                error: "NotFair was installed, but its native database module could not be prepared for this Node.js version.",
                hint: error instanceof Error ? error.message : String(error),
                command: "npm i -g notfair@latest",
              },
              { status: 500 },
            ),
          );
          return;
        }
        _resetLatestCache();
        // Confirm by refreshing the version snapshot. The current version
        // is still the old one (we're still running) — but `latest` from
        // the registry should now match what we just installed.
        const latest = await getLatestVersion(true);
        // launchd/daemon servers can restart themselves via /api/restart;
        // foreground and dev runs belong to the user's terminal.
        const managed = process.env.NOTFAIR_MANAGED ?? null;
        const canRestart = managed === "launchd" || managed === "daemon";
        resolve(
          NextResponse.json({
            ok: true,
            installed_version: latest ?? null,
            running_version: getCurrentVersion(),
            can_restart: canRestart,
            note: canRestart
              ? "Upgraded — restarting loads the new version."
              : "Upgraded. Restart NotFair to load the new version (`notfair` in your terminal).",
            elapsed_ms,
            stdout_tail: stdout.slice(-1000),
          }),
        );
      } else {
        resolve(
          NextResponse.json(
            {
              ok: false,
              error: `npm exited with code ${code}`,
              elapsed_ms,
              stdout_tail: stdout.slice(-1000),
              stderr_tail: stderr.slice(-1000),
              command: "npm i -g notfair@latest",
            },
            { status: 500 },
          ),
        );
      }
    });
  });
}

async function syncGlobalNativeBindings() {
  const root = await npmGlobalRoot();
  await syncInstalledNativeBindings(join(root, "notfair"));
}

async function npmGlobalRoot(): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn("npm", ["root", "-g"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: homedir(),
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const root = stdout.trim();
      if (code === 0 && root) {
        resolve(root);
      } else {
        reject(new Error(`Could not locate npm's global package directory (exit ${code}).`));
      }
    });
  });
}

/**
 * Next.js standalone output contains a traced copy of better-sqlite3. That
 * copy was compiled on the release builder, while npm installs the package's
 * top-level dependency for the user's current Node ABI. Replace every traced
 * native binding with that runtime-correct copy before restarting the server.
 */
export async function syncInstalledNativeBindings(packageRoot: string) {
  const runtimeBinding = join(
    packageRoot,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  const standaloneRoot = join(packageRoot, ".next", "standalone");
  const targets = await findNativeBindings(standaloneRoot);

  if (targets.length === 0) return 0;

  await Promise.all(targets.map((target) => copyFile(runtimeBinding, target)));
  return targets.length;
}

async function findNativeBindings(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findNativeBindings(path);
      if (entry.isFile() && entry.name === "better_sqlite3.node") return [path];
      return [];
    }),
  );
  return nested.flat();
}

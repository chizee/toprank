"use server";

import os from "node:os";
import { spawn } from "node:child_process";
import {
  refreshHarnessUsage,
  type HarnessUsage,
} from "@/server/harness-usage";
import { resolveCodexBinary } from "@/server/adapters/codex-local/binary";

export type StartCodexLoginResult =
  | { ok: true; alreadySignedIn: boolean }
  | { ok: false; error: string };

/**
 * Start Codex's official browser login without tying the child process to
 * the lifetime of this server-action request. The client polls auth status
 * and updates itself as soon as the browser callback completes.
 */
export async function startCodexLoginAction(): Promise<StartCodexLoginResult> {
  const current = await refreshHarnessUsage("codex-local");
  if (
    current.kind === "codex" &&
    current.auth !== "signed-out" &&
    current.auth !== "unknown"
  ) {
    return { ok: true, alreadySignedIn: true };
  }

  try {
    const child = spawn(resolveCodexBinary(), ["login"], {
      cwd: os.homedir(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return { ok: true, alreadySignedIn: false };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshCodexUsageAction(): Promise<HarnessUsage> {
  return refreshHarnessUsage("codex-local");
}

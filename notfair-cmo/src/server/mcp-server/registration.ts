import { openclaw, OpenClawError } from "@/server/openclaw/cli";

import { getOrCreateMcpServerSecret } from "./secret";

/**
 * Register notfair-cmo's outbound MCP server with OpenClaw — once, globally.
 *
 * The orchestration tools (`create_task`, `submit_task_status`,
 * `request_approval`, etc.) are project-scoped via a required `project_slug`
 * argument on every tool call, so a SINGLE OpenClaw MCP registration is
 * enough for every project + every agent in this install. Wasteful + brittle
 * to write one MCP row per project (every row points at the same URL with
 * the same secret).
 *
 * Behavior:
 *   - `ensureOrchestrationMcpInstalled()` — idempotent. Calls `openclaw mcp show`
 *     first; only writes if the row is missing OR points at a stale URL/secret.
 *     Safe to call from every provisioning step.
 *   - `installOrchestrationMcp()` — unconditional set (used by a future CLI
 *     reinstall command).
 *   - `cleanupLegacyOrchestrationRows(slugs)` — one-time migration helper that
 *     removes the per-project `<slug>-notfair-orchestration` rows we used to
 *     create. Called from provisioning so old installs heal on next provision.
 *
 * URL: `NOTFAIR_CMO_MCP_URL` if set, else
 * `http://127.0.0.1:${NOTFAIR_CMO_PORT||3326}/api/mcp/orchestration`.
 */

export const ORCHESTRATION_MCP_KEY = "notfair-orchestration";

function defaultMcpUrl(): string {
  if (process.env.NOTFAIR_CMO_MCP_URL?.trim()) {
    return process.env.NOTFAIR_CMO_MCP_URL.trim();
  }
  const port = process.env.NOTFAIR_CMO_PORT?.trim() || "3326";
  return `http://127.0.0.1:${port}/api/mcp/orchestration`;
}

function buildConfig(): { url: string; transport: string; headers: Record<string, string> } {
  return {
    url: defaultMcpUrl(),
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${getOrCreateMcpServerSecret()}` },
  };
}

export type InstallResult =
  | { ok: true; status: "already_installed" | "installed" | "updated"; key: string; url: string }
  | { ok: false; key: string; url: string; error: string };

/**
 * Idempotent install. Reads the current row; writes only when missing or
 * stale (URL changed via NOTFAIR_CMO_MCP_URL, secret rotated, etc.).
 */
export async function ensureOrchestrationMcpInstalled(): Promise<InstallResult> {
  const desired = buildConfig();
  const key = ORCHESTRATION_MCP_KEY;
  const current = await readMcpRow(key);
  if (current && configMatches(current, desired)) {
    return { ok: true, status: "already_installed", key, url: desired.url };
  }
  try {
    await openclaw(["mcp", "set", key, JSON.stringify(desired)], { json: false });
    return {
      ok: true,
      status: current ? "updated" : "installed",
      key,
      url: desired.url,
    };
  } catch (err) {
    const message =
      err instanceof OpenClawError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, key, url: desired.url, error: message };
  }
}

/** Unconditional install — overwrites whatever's there. */
export async function installOrchestrationMcp(): Promise<InstallResult> {
  const desired = buildConfig();
  const key = ORCHESTRATION_MCP_KEY;
  try {
    await openclaw(["mcp", "set", key, JSON.stringify(desired)], { json: false });
    return { ok: true, status: "installed", key, url: desired.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, key, url: desired.url, error: message };
  }
}

/**
 * Remove the legacy per-project `<slug>-notfair-orchestration` rows we wrote
 * before the registration went global. Pass the list of project slugs that
 * may have stale rows. Errors per-slug are swallowed (the row may already be
 * gone). Safe + idempotent — no-op on a fresh install.
 */
export async function cleanupLegacyOrchestrationRows(
  slugs: string[],
): Promise<void> {
  for (const slug of slugs) {
    const legacyKey = `${slug}-notfair-orchestration`;
    try {
      await openclaw(["mcp", "unset", legacyKey], { json: false });
    } catch {
      // Row didn't exist or unset failed; ignore.
    }
  }
}

async function readMcpRow(key: string): Promise<{
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
} | null> {
  try {
    const out = await openclaw(["mcp", "show", key], { json: true });
    if (!out || typeof out !== "object") return null;
    return out as {
      url?: string;
      transport?: string;
      headers?: Record<string, string>;
    };
  } catch (err) {
    if (err instanceof OpenClawError) return null;
    throw err;
  }
}

function configMatches(
  current: { url?: string; transport?: string; headers?: Record<string, string> },
  desired: { url: string; transport: string; headers: Record<string, string> },
): boolean {
  if (current.url !== desired.url) return false;
  if (current.transport !== desired.transport) return false;
  const currentAuth =
    current.headers?.Authorization ?? current.headers?.authorization;
  if (currentAuth !== desired.headers.Authorization) return false;
  return true;
}

/** Read-only URL accessor for CLI/tooling. */
export function getOrchestrationMcpUrl(): string {
  return defaultMcpUrl();
}

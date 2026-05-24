import { openclaw, OpenClawError } from "@/server/openclaw/cli";
import { bearerFromHeaders, mcpRpc, readMcpConfigRow } from "@/server/mcp/rpc";

/**
 * Read the merged state of a configured MCP server from OpenClaw + a fast
 * health probe. We keep this thin: source of truth is openclaw.json (the
 * config the CLI manages); we don't shadow-store tokens locally.
 *
 * `connection_state`:
 *  - "not_configured": no row in `openclaw mcp` for this key
 *  - "configured_no_token": row exists but lacks an Authorization header
 *  - "connected": row + token + probe succeeded
 *  - "stale_token": row + token but probe came back 401/403
 *  - "unreachable": row + token but probe failed (network/timeout/5xx)
 *
 * HTTP plumbing (config-read, bearer parse, JSON-RPC POST, SSE handling)
 * lives in `@/server/mcp/rpc`. This file owns only the UI status mapping.
 */

export type McpRuntimeStatus =
  | { state: "not_configured" }
  | { state: "configured_no_token"; url: string }
  | {
      state: "connected";
      url: string;
      tools_count: number | null;
      last_checked_at: string;
    }
  | {
      state: "stale_token";
      url: string;
      http_status: number;
      last_checked_at: string;
    }
  | {
      state: "unreachable";
      url: string;
      error: string;
      last_checked_at: string;
    };

export async function getMcpStatus(key: string): Promise<McpRuntimeStatus> {
  const config = await readMcpConfigRow(key);
  if (!config || !config.url) return { state: "not_configured" };
  const url = config.url;
  const token = bearerFromHeaders(config.headers);
  if (!token) return { state: "configured_no_token", url };
  return probe(url, token);
}

/**
 * Lightweight liveness probe. POSTs JSON-RPC `tools/list` — the cheapest MCP
 * call that exercises auth + transport in one round-trip. 2s timeout: this
 * renders server-side on the MCP tab and we'd rather show "unreachable" than
 * block the page.
 */
async function probe(url: string, token: string): Promise<McpRuntimeStatus> {
  const last_checked_at = new Date().toISOString();
  const r = await mcpRpc<{ tools?: unknown }>(
    url,
    token,
    "tools/list",
    {},
    { timeoutMs: 2000 },
  );
  if (r.ok) {
    return {
      state: "connected",
      url,
      tools_count: countToolsFromResult(r.result),
      last_checked_at,
    };
  }
  if (r.kind === "http_error" && (r.status === 401 || r.status === 403)) {
    return { state: "stale_token", url, http_status: r.status, last_checked_at };
  }
  if (r.kind === "http_error") {
    return { state: "unreachable", url, error: `HTTP ${r.status}`, last_checked_at };
  }
  if (r.kind === "timeout") {
    return { state: "unreachable", url, error: "timed out", last_checked_at };
  }
  if (r.kind === "aborted") {
    return { state: "unreachable", url, error: "aborted", last_checked_at };
  }
  if (r.kind === "rpc_error") {
    return {
      state: "unreachable",
      url,
      error: `rpc error ${r.code}: ${r.message}`,
      last_checked_at,
    };
  }
  if (r.kind === "malformed_response") {
    return {
      state: "unreachable",
      url,
      error: `malformed response: ${r.message}`,
      last_checked_at,
    };
  }
  // network_error
  return { state: "unreachable", url, error: r.message, last_checked_at };
}

function countToolsFromResult(result: { tools?: unknown } | undefined): number | null {
  if (!result || typeof result !== "object") return null;
  if (!Array.isArray(result.tools)) return null;
  return result.tools.length;
}

export async function disconnectMcp(key: string): Promise<void> {
  try {
    await openclaw(["mcp", "unset", key], { json: false });
  } catch (err) {
    // If the row was already gone, treat as success — UI calls this on a
    // "Disconnect" button that should be idempotent.
    if (err instanceof OpenClawError && err.exitCode !== 0) {
      const msg = (err.stderr ?? "").toLowerCase();
      if (msg.includes("not found") || msg.includes("unknown")) return;
    }
    throw err;
  }
}

export async function setMcpBearer(
  key: string,
  url: string,
  token: string,
): Promise<void> {
  // Project scoping is via the openclaw key namespace alone (project slug
  // prefix). We deliberately do not write `codex.agents`: it only worked
  // for the Codex app-server runtime and was silently ignored on other
  // backends (DeepSeek, Claude, etc.), so its semantics were inconsistent.
  // Per-project tokens + project-prefixed keys give us a uniform "soft
  // isolation" model that's the same across every runtime.
  const config = {
    url,
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${token}` },
  };
  await openclaw(["mcp", "set", key, JSON.stringify(config)], { json: false });
}

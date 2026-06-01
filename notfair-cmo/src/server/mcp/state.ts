import { findMcpToken, upsertMcpToken, deleteMcpToken } from "./tokens";
import { mcpSpecByKey } from "@/server/mcp-catalog";
import { mcpRpc } from "./rpc";

/**
 * Status surface for the Connections page + dashboard banners.
 *
 *  - "not_configured": no row in mcp_tokens
 *  - "configured_no_token": (legacy compat — pre-OAuth half-config rows)
 *  - "connected": token present and probe succeeded
 *  - "stale_token": probe came back 401/403
 *  - "unreachable": probe failed (network/timeout/5xx)
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

export async function getMcpStatus(
  project_slug: string,
  catalog_key: string,
): Promise<McpRuntimeStatus> {
  const spec = mcpSpecByKey(catalog_key);
  if (!spec) return { state: "not_configured" };
  const token = findMcpToken(project_slug, catalog_key);
  if (!token) return { state: "not_configured" };
  return probe(spec.resource_url, token.access_token_enc);
}

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
  return { state: "unreachable", url, error: r.message, last_checked_at };
}

function countToolsFromResult(result: { tools?: unknown } | undefined): number | null {
  if (!result || typeof result !== "object") return null;
  if (!Array.isArray(result.tools)) return null;
  return result.tools.length;
}

export async function disconnectMcp(project_slug: string, catalog_key: string): Promise<void> {
  const token = findMcpToken(project_slug, catalog_key);
  if (token) deleteMcpToken(token.id);
}

export async function setMcpBearer(
  project_slug: string,
  catalog_key: string,
  token: string,
  options: { scope?: string; expires_at?: string } = {},
): Promise<void> {
  upsertMcpToken({
    project_slug,
    server_name: catalog_key,
    access_token: token,
    scope: options.scope,
    expires_at: options.expires_at,
  });
}

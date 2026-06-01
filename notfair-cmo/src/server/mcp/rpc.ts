import { findMcpToken } from "@/server/mcp/tokens";
import { mcpSpecByKey } from "@/server/mcp-catalog";

/**
 * Shared MCP HTTP plumbing. Two callers use this today:
 *   - `mcp/state.ts:probe()` (liveness check via tools/list)
 *   - `onboarding/audit.ts` (real audit via tools/call runScript)
 *
 * Single source of truth for: token lookup (from notfair-cmo SQLite), bearer
 * extraction, JSON-RPC envelope construction, SSE-vs-JSON response parsing,
 * error shapes.
 *
 * Security: never log the bearer. Token is held in memory only for the
 * duration of one RPC call.
 */

export interface McpConfigRow {
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  url: string;
  token: string;
}

export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "http_error"; status: number; body?: string }
  | { ok: false; kind: "timeout" }
  | { ok: false; kind: "aborted" }
  | { ok: false; kind: "network_error"; message: string }
  | { ok: false; kind: "rpc_error"; code: number; message: string }
  | { ok: false; kind: "malformed_response"; message: string };

/**
 * Look up an MCP config row by (project_slug, catalog_key). Returns null when
 * no token is stored or the catalog entry is unknown. Replaces the legacy
 * `openclaw mcp show` subprocess that backed the same surface.
 */
export function readMcpConfigRow(
  project_slug: string,
  catalog_key: string,
): McpConfigRow | null {
  const spec = mcpSpecByKey(project_slug, catalog_key);
  if (!spec) return null;
  const token = findMcpToken(project_slug, catalog_key);
  if (!token) return { url: spec.resource_url };
  return {
    url: spec.resource_url,
    headers: { Authorization: `Bearer ${token.access_token_enc}` },
  };
}

export function bearerFromHeaders(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  const raw = headers.Authorization ?? headers.authorization;
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function getMcpConfig(project_slug: string, catalog_key: string): McpConfig | null {
  const row = readMcpConfigRow(project_slug, catalog_key);
  if (!row || !row.url) return null;
  const token = bearerFromHeaders(row.headers);
  if (!token) return null;
  return { url: row.url, token };
}

export interface McpRpcOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function mcpRpc<T = unknown>(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: McpRpcOpts = {},
): Promise<RpcResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        // MCP Streamable-HTTP 2025-06-18 §3.3: clients SHOULD declare
        // the intended protocol version on every request, and strict
        // servers (Supabase, etc.) return HTTP 400 when it's absent.
        // Lenient servers (Stripe, NotFair) ignore it. Safe to send
        // unconditionally.
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (timerFired) return { ok: false, kind: "timeout" };
    if (opts.signal?.aborted) return { ok: false, kind: "aborted" };
    return {
      ok: false,
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    // Try to capture the body so callers can surface the real upstream
    // error (e.g. Supabase's "must initialize first" or a missing-scope
    // message). Best-effort: if the read fails or the body is huge, fall
    // back to just the status.
    let errBody: string | undefined;
    try {
      const raw = await res.text();
      errBody = raw.trim() ? raw.slice(0, 500) : undefined;
    } catch {
      // ignore
    }
    cleanup();
    return { ok: false, kind: "http_error", status: res.status, body: errBody };
  }

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    cleanup();
    if (timerFired) return { ok: false, kind: "timeout" };
    if (opts.signal?.aborted) return { ok: false, kind: "aborted" };
    return {
      ok: false,
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  cleanup();

  return parseRpcBody<T>(body);
}

function parseRpcBody<T>(body: string): RpcResult<T> {
  const envelope = pickRpcEnvelope(body);
  if (envelope === null) {
    return { ok: false, kind: "malformed_response", message: "empty body" };
  }
  let parsed: { result?: T; error?: { code: number; message: string } };
  try {
    parsed = JSON.parse(envelope) as typeof parsed;
  } catch (err) {
    return {
      ok: false,
      kind: "malformed_response",
      message: err instanceof Error ? err.message : "JSON parse failed",
    };
  }
  if (parsed.error) {
    return { ok: false, kind: "rpc_error", code: parsed.error.code, message: parsed.error.message };
  }
  if (parsed.result === undefined) {
    return {
      ok: false,
      kind: "malformed_response",
      message: "envelope has neither result nor error",
    };
  }
  return { ok: true, result: parsed.result };
}

function pickRpcEnvelope(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:")) {
    return trimmed;
  }
  const frames = trimmed
    .split(/\n\n+/)
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join(""),
    )
    .filter((s) => s.length > 0);
  if (frames.length === 0) return null;
  return frames[frames.length - 1] ?? null;
}

import { openclaw, OpenClawError } from "@/server/openclaw/cli";

/**
 * Shared MCP HTTP plumbing. Two callers use this today:
 *   - `mcp-state.ts:probe()` (liveness check via tools/list)
 *   - `onboarding/audit.ts` (real audit via tools/call runScript)
 *
 * Single source of truth for: subprocess-config read, bearer extraction,
 * JSON-RPC envelope construction, SSE-vs-JSON response parsing, error shapes.
 *
 * Security: never log the McpConfig.token. The bearer is held in memory only
 * for the duration of one RPC call. `openclaw mcp show` subprocess output
 * must never be logged either (full stdout contains the token in headers).
 */

export type McpConfigRow = {
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
};

export type McpConfig = { url: string; token: string };

export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "http_error"; status: number }
  | { ok: false; kind: "timeout" }
  | { ok: false; kind: "aborted" }
  | { ok: false; kind: "network_error"; message: string }
  | { ok: false; kind: "rpc_error"; code: number; message: string }
  | { ok: false; kind: "malformed_response"; message: string };

/**
 * Read the raw MCP config row from OpenClaw. Returns null when the key is
 * unknown (OpenClaw exits non-zero). Callers that need to distinguish
 * "no row" from "row but no bearer" (e.g., the UI status surface) should
 * use this + bearerFromHeaders directly. Callers that just need usable
 * credentials should use getMcpConfig.
 */
export async function readMcpConfigRow(key: string): Promise<McpConfigRow | null> {
  try {
    const out = await openclaw(["mcp", "show", key], { json: true });
    if (!out || typeof out !== "object") return null;
    return out as McpConfigRow;
  } catch (err) {
    if (err instanceof OpenClawError) return null;
    throw err;
  }
}

/** Parse the bearer out of an `Authorization: Bearer <token>` header. */
export function bearerFromHeaders(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  const raw = headers.Authorization ?? headers.authorization;
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Convenience wrapper for callers that just need URL + bearer. Returns null
 * when the key isn't configured OR has no bearer — the two failure modes
 * collapse to the same "can't talk to this MCP" answer.
 */
export async function getMcpConfig(key: string): Promise<McpConfig | null> {
  const row = await readMcpConfigRow(key);
  if (!row || !row.url) return null;
  const token = bearerFromHeaders(row.headers);
  if (!token) return null;
  return { url: row.url, token };
}

export type McpRpcOpts = {
  /** Hard timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Caller's abort signal — composed with our internal timeout. */
  signal?: AbortSignal;
};

/**
 * Send one JSON-RPC call to an MCP server over streamable-http transport.
 *
 * Every failure has a named kind so callers can branch:
 *   - http_error       — non-2xx HTTP (401/403 = stale token; 5xx = server)
 *   - timeout          — our internal timer fired
 *   - aborted          — caller's signal fired
 *   - network_error    — fetch threw before getting a response
 *   - rpc_error        — server returned a JSON-RPC error envelope
 *   - malformed_response — body wasn't parseable JSON-RPC
 *
 * Body is buffered (text() then parsed). MCP can reply with either plain
 * JSON or SSE-framed (`data: ...\n\n`); for a single RPC we want the final
 * envelope, so we extract the last `data:` frame when SSE is detected.
 */
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
    cleanup();
    return { ok: false, kind: "http_error", status: res.status };
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
    return {
      ok: false,
      kind: "rpc_error",
      code: parsed.error.code,
      message: parsed.error.message,
    };
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

/**
 * MCP streamable-http can return plain JSON OR SSE (`data: ...\n\n`).
 * For a single RPC we want the last full `data:` frame; for plain JSON we
 * return the body as-is. Returns null when the body has no usable envelope.
 */
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

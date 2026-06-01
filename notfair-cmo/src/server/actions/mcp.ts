"use server";

import { randomBytes, createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getActiveProject } from "@/server/active-project";
import { mcpSpecByKey } from "@/server/mcp-catalog";
import { setPending } from "@/server/mcp-pending";
import { disconnectMcp as runDisconnect } from "@/server/mcp/state";

export type StartMcpConnectResult =
  | { ok: true; authorize_url: string }
  | { ok: false; error: string };

/**
 * Begin a one-click MCP OAuth flow. Server-side: discovery → DCR →
 * PKCE-pair → pending-state stash → caller redirects browser to the
 * authorize URL we return. The callback handler in
 * `/api/mcp-oauth/callback` finishes the exchange + writes the openclaw
 * mcp config.
 */
export async function startMcpConnect(input: {
  mcp_key: string;
  /**
   * Same-origin path to bounce back to after the callback. Anything that
   * doesn't look like a local path (no leading `/`, or `//` protocol-relative)
   * is dropped — the callback will use the default `/connections` instead.
   */
  return_to?: string;
}): Promise<StartMcpConnectResult> {
  const spec = mcpSpecByKey(input.mcp_key);
  if (!spec) return { ok: false, error: `Unknown MCP key: ${input.mcp_key}` };

  const project = await getActiveProject();
  if (!project) {
    return { ok: false, error: "No active project. Pick one before connecting an MCP." };
  }

  let resolved: ResolvedAuthServer;
  try {
    resolved = await resolveAuthServer(spec.discovery_url);
  } catch (err) {
    return { ok: false, error: `Discovery failed: ${humanError(err)}` };
  }

  const origin = await originFromIncomingRequest();
  const redirect_uri = `${origin}/api/mcp-oauth/callback`;

  let dcr: DcrResponse;
  try {
    dcr = await dynamicRegister(resolved.registration_endpoint, redirect_uri);
  } catch (err) {
    return { ok: false, error: `Registration failed: ${humanError(err)}` };
  }

  // PKCE — S256 challenge from a 64-byte verifier.
  const code_verifier = base64url(randomBytes(64));
  const code_challenge = base64url(
    createHash("sha256").update(code_verifier).digest(),
  );
  const state = base64url(randomBytes(24));

  setPending(state, {
    catalog_key: spec.key,
    display_name: spec.display_name,
    resource_url: spec.resource_url,
    issuer: resolved.issuer,
    token_endpoint: resolved.token_endpoint,
    client_id: dcr.client_id,
    client_secret: dcr.client_secret,
    code_verifier,
    redirect_uri,
    project_slug: project.slug,
    return_to: sanitizeReturnTo(input.return_to),
    created_at: Date.now(),
  });

  const u = new URL(resolved.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", dcr.client_id);
  u.searchParams.set("redirect_uri", redirect_uri);
  u.searchParams.set("code_challenge", code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", spec.resource_url);

  return { ok: true, authorize_url: u.toString() };
}

export async function disconnectMcpAction(input: {
  mcp_key: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const project = await getActiveProject();
  if (!project) {
    return { ok: false, error: "No active project to disconnect from." };
  }
  try {
    await runDisconnect(project.slug, input.mcp_key);
  } catch (err) {
    return { ok: false, error: humanError(err) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Fetch the tool list for an external (OAuth-connected) MCP. Driven by the
 * tools modal on the Connections page — lazy on dialog-open so we don't
 * pay the RPC roundtrip when the user is just glancing at the page.
 *
 * Probes the MCP's tools/list endpoint with the stored bearer, then
 * normalizes each entry into the same ToolSummary shape we ship for
 * built-in tools — the modal renders both identically.
 */
export async function listMcpToolsAction(input: {
  mcp_key: string;
}): Promise<
  | { ok: true; tools: import("@/server/mcp-server/tool-summaries").ToolSummary[] }
  | { ok: false; error: string }
> {
  const project = await getActiveProject();
  if (!project) {
    return { ok: false, error: "No active project." };
  }
  const { getMcpConfig, mcpRpc } = await import("@/server/mcp/rpc");
  const cfg = getMcpConfig(project.slug, input.mcp_key);
  if (!cfg) {
    return { ok: false, error: "MCP is not configured for this project." };
  }
  const r = await mcpRpc<{ tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> }>(
    cfg.url,
    cfg.token,
    "tools/list",
    {},
    { timeoutMs: 5_000 },
  );
  if (!r.ok) {
    const message =
      r.kind === "http_error"
        ? `HTTP ${r.status}`
        : r.kind === "rpc_error"
          ? `RPC ${r.code}: ${r.message}`
          : r.kind === "timeout"
            ? "MCP call timed out"
            : r.kind === "aborted"
              ? "MCP call aborted"
              : r.kind === "malformed_response"
                ? r.message
                : r.message;
    return { ok: false, error: message };
  }
  const { argsFromJsonSchema } = await import("@/server/mcp-server/tool-summaries");
  const tools = Array.isArray(r.result?.tools)
    ? r.result.tools
        .filter(
          (
            t,
          ): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
            typeof t?.name === "string",
        )
        .map((t) => ({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          args:
            t.inputSchema && typeof t.inputSchema === "object"
              ? argsFromJsonSchema(t.inputSchema)
              : [],
        }))
    : [];
  return { ok: true, tools };
}

// ─── helpers ────────────────────────────────────────────────────────

type ResolvedAuthServer = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

async function resolveAuthServer(
  resourceDiscoveryUrl: string,
): Promise<ResolvedAuthServer> {
  // RFC 9728: GET .well-known/oauth-protected-resource → carries the
  // `authorization_servers` array. We pick the first and then fetch its
  // RFC 8414 AS metadata to learn registration/token/authorize endpoints.
  const r1 = await fetchJson(resourceDiscoveryUrl, 8000);
  const servers = (r1 as { authorization_servers?: unknown }).authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error("no authorization_servers in discovery doc");
  }
  const issuer = String(servers[0]).replace(/\/$/, "");
  // Standard AS metadata path; some notfair-style servers also accept a
  // path-suffixed variant. Try the standard first — the path-suffixed
  // variant is a hint for clients that skip RFC 9728, which we just
  // didn't.
  const asMetaUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const meta = (await fetchJson(asMetaUrl, 8000)) as Partial<ResolvedAuthServer>;
  if (
    !meta.authorization_endpoint
    || !meta.token_endpoint
    || !meta.registration_endpoint
  ) {
    throw new Error("AS metadata missing endpoints");
  }
  return {
    issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
  };
}

type DcrResponse = {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
};

async function dynamicRegister(
  registration_endpoint: string,
  redirect_uri: string,
): Promise<DcrResponse> {
  // Register as `none` (public client) so we drive token exchange with
  // PKCE + no secret per the MCP spec. Servers that don't yet support
  // public clients will still return a client_secret — we keep it for
  // back-compat fallback, but the token handler favors PKCE.
  const body = {
    client_name: "notfair-cmo",
    redirect_uris: [redirect_uri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const res = await fetch(registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DCR ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as DcrResponse;
  if (!json.client_id) throw new Error("DCR response missing client_id");
  return json;
}

async function fetchJson(url: string, timeout_ms: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout_ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function base64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function originFromIncomingRequest(): Promise<string> {
  const h = await headers();
  // Next surfaces forwarded headers when behind a proxy; fall back to host.
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) {
    throw new Error("Could not derive origin from request headers");
  }
  return `${proto}://${host}`;
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Accept only same-origin, path-only redirect targets. Anything with a scheme
 * or a `//` prefix would let a caller redirect the user off-site after OAuth,
 * which is an open-redirect class bug. Returns undefined when the input
 * isn't a safe local path, so the callback falls back to /connections.
 */
function sanitizeReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined;
  return raw;
}

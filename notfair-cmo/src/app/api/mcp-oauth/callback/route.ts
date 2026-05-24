import { NextResponse } from "next/server";
import { consumePending } from "@/server/mcp-pending";
import { setMcpBearer } from "@/server/mcp-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OAuth 2.0 redirect URI for the one-click MCP connect flow. The browser
 * lands here after the user authorizes upstream. We look up the pending
 * flow by `state`, exchange the code for an access token, write the
 * MCP config via `openclaw mcp set`, and bounce the user back to the
 * agent's MCP tab.
 *
 * On failure we still redirect (so the browser doesn't end up on a raw
 * JSON page); the destination carries `?mcp_error=…` for the page to
 * surface. The pending entry is always consumed.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const upstreamError = url.searchParams.get("error");

  if (!state) {
    return htmlErrorPage("Missing state parameter; cannot resume the OAuth flow.");
  }

  const pending = consumePending(state);
  if (!pending) {
    return htmlErrorPage("This authorization link has expired or was already used.");
  }

  // The pending state may carry a `return_to` (e.g. the chat URL the user
  // started from). Default to / so the root redirect bounces them to their
  // active project's home if no caller asked for a specific destination.
  // `return_to` is already sanitized in startMcpConnect to be a same-origin
  // path; URL() with a base will additionally reject anything malformed.
  const back = new URL(pending.return_to ?? "/", request.url);

  if (upstreamError) {
    back.searchParams.set(
      "mcp_error",
      `Authorization rejected: ${upstreamError}`,
    );
    return NextResponse.redirect(back);
  }
  if (!code) {
    back.searchParams.set("mcp_error", "Authorization callback returned no code.");
    return NextResponse.redirect(back);
  }

  // Token exchange. Send PKCE + (defensively) the secret. Servers that
  // honor token_endpoint_auth_method=none ignore the secret; servers that
  // require it still accept this request. Either way PKCE is validated.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_verifier: pending.code_verifier,
    resource: pending.resource_url,
  });
  if (pending.client_secret) body.set("client_secret", pending.client_secret);

  let access_token: string;
  try {
    const res = await fetch(pending.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      back.searchParams.set(
        "mcp_error",
        `Token exchange failed (HTTP ${res.status}): ${truncate(text, 200)}`,
      );
      return NextResponse.redirect(back);
    }
    const parsed = JSON.parse(text) as { access_token?: string };
    if (!parsed.access_token) {
      back.searchParams.set("mcp_error", "Token endpoint returned no access_token.");
      return NextResponse.redirect(back);
    }
    access_token = parsed.access_token;
  } catch (err) {
    back.searchParams.set(
      "mcp_error",
      `Token exchange error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.redirect(back);
  }

  try {
    await setMcpBearer(pending.stored_key, pending.resource_url, access_token);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Scrub bearers + any oat_ token shape before exposing in the URL —
    // the redirect lands in browser history, server logs, and Referer
    // headers on the destination page. Leaking the access token there
    // would let any local-machine reader replay calls against the MCP.
    const scrubbed = raw
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
      .replace(/oat_[A-Za-z0-9_]+/gi, "oat_[redacted]");
    back.searchParams.set("mcp_error", `Saving MCP config failed: ${scrubbed}`);
    return NextResponse.redirect(back);
  }

  // Flash banner uses the catalog name (what the user recognizes), not the
  // project-prefixed openclaw key.
  back.searchParams.set("mcp_connected", pending.display_name);
  return NextResponse.redirect(back);
}

function htmlErrorPage(message: string): Response {
  // Shown only when we can't even resolve the pending flow, so we have no
  // agent slug to redirect to. Bare minimal HTML — Tailwind isn't loaded.
  const body = `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:36rem;margin:auto">
<h1 style="margin:0 0 1rem;font-size:1.25rem">Couldn’t complete MCP connection</h1>
<p style="color:#666">${escapeHtml(message)}</p>
<p style="margin-top:2rem"><a href="/">← Back to app</a></p>
</body></html>`;
  return new Response(body, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

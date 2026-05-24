import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consumePendingMock = vi.fn();
vi.mock("@/server/mcp-pending", () => ({
  consumePending: (...args: unknown[]) => consumePendingMock(...args),
}));

const setMcpBearerMock = vi.fn();
vi.mock("@/server/mcp-state", () => ({
  setMcpBearer: (...args: unknown[]) => setMcpBearerMock(...args),
}));

import { GET } from "./route";

function makeReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

function makePending(overrides: Record<string, unknown> = {}) {
  return {
    catalog_key: "notfair-googleads",
    stored_key: "acme-notfair-googleads",
    display_name: "NotFair Google Ads",
    resource_url: "https://mcp.example.com/sse",
    issuer: "https://auth.example.com",
    token_endpoint: "https://auth.example.com/token",
    client_id: "client-123",
    client_secret: "secret-456",
    code_verifier: "verifier",
    redirect_uri: "http://localhost/api/mcp-oauth/callback",
    project_slug: "acme",
    return_to: "/acme/agents/cmo/mcp",
    created_at: Date.now(),
    ...overrides,
  };
}

describe("GET /api/mcp-oauth/callback", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 400 HTML when state param is missing", async () => {
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?code=abc"),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Missing state parameter");
  });

  it("returns 400 HTML when pending flow is not found / expired", async () => {
    consumePendingMock.mockReturnValueOnce(null);
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=ghost&code=abc"),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("expired or was already used");
  });

  it("redirects with mcp_error when upstream returned an error param", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    const res = await GET(
      makeReq(
        "http://localhost/api/mcp-oauth/callback?state=s1&error=access_denied",
      ),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/acme/agents/cmo/mcp");
    expect(location.searchParams.get("mcp_error")).toContain("access_denied");
  });

  it("redirects with mcp_error when code is missing", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("mcp_error")).toContain("no code");
  });

  it("redirects with mcp_error when token exchange returns non-2xx", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    const res = await GET(
      makeReq(
        "http://localhost/api/mcp-oauth/callback?state=s1&code=abc",
      ),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("mcp_error")).toContain("HTTP 400");
    expect(location.searchParams.get("mcp_error")).toContain("bad");
  });

  it("redirects with mcp_error when token response is missing access_token", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("mcp_error")).toContain(
      "no access_token",
    );
  });

  it("redirects with mcp_error when fetch throws", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    fetchMock.mockRejectedValueOnce(new TypeError("network fail"));
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("mcp_error")).toContain("network fail");
  });

  it("redirects with mcp_error when setMcpBearer throws (and scrubs bearer + oat_ tokens)", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "the-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    setMcpBearerMock.mockRejectedValueOnce(
      new Error(
        "Failed: Bearer abc.DEF-123_456 and oat_aBcDeF leaked here",
      ),
    );
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    const errMsg = location.searchParams.get("mcp_error")!;
    expect(errMsg).toContain("Saving MCP config failed");
    expect(errMsg).toContain("Bearer [redacted]");
    expect(errMsg).toContain("oat_[redacted]");
    expect(errMsg).not.toContain("abc.DEF-123_456");
    expect(errMsg).not.toContain("oat_aBcDeF");
  });

  it("redirects with mcp_connected on full success and includes client_secret in token body", async () => {
    const pending = makePending();
    consumePendingMock.mockReturnValueOnce(pending);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "live-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    setMcpBearerMock.mockResolvedValueOnce(undefined);

    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/acme/agents/cmo/mcp");
    expect(location.searchParams.get("mcp_connected")).toBe(
      "NotFair Google Ads",
    );

    expect(setMcpBearerMock).toHaveBeenCalledWith(
      "acme-notfair-googleads",
      "https://mcp.example.com/sse",
      "live-token",
    );

    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe("https://auth.example.com/token");
    const body = (init as RequestInit).body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=abc");
    expect(body).toContain("client_id=client-123");
    expect(body).toContain("client_secret=secret-456");
    expect(body).toContain("code_verifier=verifier");
  });

  it("omits client_secret when pending flow has none (public client)", async () => {
    const pending = makePending({ client_secret: undefined });
    consumePendingMock.mockReturnValueOnce(pending);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    setMcpBearerMock.mockResolvedValueOnce(undefined);

    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const body = fetchMock.mock.calls[0]![1].body as string;
    expect(body).not.toContain("client_secret");
  });

  it("defaults return_to to '/' when pending flow has no return_to", async () => {
    const pending = makePending({ return_to: undefined });
    consumePendingMock.mockReturnValueOnce(pending);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    setMcpBearerMock.mockResolvedValueOnce(undefined);

    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/");
  });

  it("truncates very long token-exchange error responses in the redirect URL", async () => {
    consumePendingMock.mockReturnValueOnce(makePending());
    const longBody = "x".repeat(500);
    fetchMock.mockResolvedValueOnce(new Response(longBody, { status: 500 }));
    const res = await GET(
      makeReq("http://localhost/api/mcp-oauth/callback?state=s1&code=abc"),
    );
    expect(res.status).toBe(307);
    const errMsg = new URL(res.headers.get("location")!).searchParams.get(
      "mcp_error",
    )!;
    // We truncate at 200 chars plus an ellipsis.
    expect(errMsg).toContain("…");
    expect(errMsg.length).toBeLessThan(longBody.length);
  });
});

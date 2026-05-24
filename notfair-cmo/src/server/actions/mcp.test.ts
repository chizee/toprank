import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const headerGetMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (...args: unknown[]) => headerGetMock(...args),
  }),
}));

const getActiveProjectMock = vi.fn();
vi.mock("@/server/active-project", () => ({
  getActiveProject: (...args: unknown[]) => getActiveProjectMock(...args),
}));

const setPendingMock = vi.fn();
vi.mock("@/server/mcp-pending", () => ({
  setPending: (...args: unknown[]) => setPendingMock(...args),
}));

const runDisconnectMock = vi.fn();
vi.mock("@/server/mcp-state", () => ({
  disconnectMcp: (...args: unknown[]) => runDisconnectMock(...args),
}));

// Use the real mcp-catalog so storedMcpKey + mcpSpecByKey work.

import { disconnectMcpAction, startMcpConnect } from "./mcp";

function project(slug = "acme") {
  return {
    id: "uuid",
    slug,
    display_name: "Acme",
    created_at: "now",
    archived_at: null,
    google_ads_account_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default header values; individual tests override as needed.
  headerGetMock.mockImplementation((name: string) => {
    if (name === "host") return "localhost:3326";
    return null;
  });
});

describe("startMcpConnect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects unknown mcp_key", async () => {
    const r = await startMcpConnect({ mcp_key: "not-a-real-mcp" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Unknown MCP key/);
  });

  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No active project/);
  });

  it("surfaces discovery failures", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Discovery failed/);
    expect(r.error).toMatch(/HTTP 404/);
  });

  it("surfaces missing authorization_servers in protected-resource doc", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no authorization_servers/);
  });

  it("surfaces incomplete AS metadata", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com/"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          // missing token_endpoint + registration_endpoint
        }),
      });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/AS metadata missing endpoints/);
  });

  it("surfaces DCR failures with status code + text snippet", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "bad payload",
      });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Registration failed/);
    expect(r.error).toMatch(/DCR 400/);
  });

  it("surfaces DCR response missing client_id", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing client_id/);
  });

  it("happy path: stashes pending flow and returns authorize URL with PKCE", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com/"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "client-xyz", client_secret: "shh" }),
      });
    const r = await startMcpConnect({
      mcp_key: "notfair-googleads",
      return_to: "/chat/foo",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.authorize_url);
    expect(url.origin).toBe("https://as.example.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-xyz");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3326/api/mcp-oauth/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("resource")).toBe(
      "https://notfair.co/api/mcp/google_ads",
    );

    expect(setPendingMock).toHaveBeenCalledTimes(1);
    const [state, flow] = setPendingMock.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(state).toBe(url.searchParams.get("state"));
    expect(flow).toMatchObject({
      catalog_key: "notfair-googleads",
      stored_key: "acme-notfair-googleads",
      issuer: "https://as.example.com",
      token_endpoint: "https://as.example.com/token",
      client_id: "client-xyz",
      client_secret: "shh",
      redirect_uri: "http://localhost:3326/api/mcp-oauth/callback",
      project_slug: "acme",
      return_to: "/chat/foo",
    });
    expect(typeof flow.code_verifier).toBe("string");
    expect((flow.code_verifier as string).length).toBeGreaterThan(50);
  });

  it("uses x-forwarded-proto + x-forwarded-host when behind a proxy", async () => {
    headerGetMock.mockImplementation((name: string) => {
      if (name === "x-forwarded-proto") return "https";
      if (name === "x-forwarded-host") return "app.example.com";
      if (name === "host") return "internal-host";
      return null;
    });
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "c" }),
      });
    const r = await startMcpConnect({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authorize_url).toMatch(/redirect_uri=https%3A%2F%2Fapp\.example\.com/);
  });

  it("throws-as-error path: missing host header surfaces as discovery error", async () => {
    headerGetMock.mockImplementation(() => null);
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      });
    await expect(
      startMcpConnect({ mcp_key: "notfair-googleads" }),
    ).rejects.toThrow(/Could not derive origin/);
  });

  it("rejects open-redirect return_to (absolute URL)", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "c" }),
      });
    await startMcpConnect({
      mcp_key: "notfair-googleads",
      return_to: "https://evil.example.com/steal",
    });
    const [, flow] = setPendingMock.mock.calls[0]!;
    expect((flow as { return_to: string | undefined }).return_to).toBeUndefined();
  });

  it("rejects open-redirect return_to (protocol-relative)", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_servers: ["https://as.example.com"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "c" }),
      });
    await startMcpConnect({
      mcp_key: "notfair-googleads",
      return_to: "//evil.example.com/x",
    });
    const [, flow] = setPendingMock.mock.calls[0]!;
    expect((flow as { return_to: string | undefined }).return_to).toBeUndefined();
  });
});

describe("disconnectMcpAction", () => {
  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await disconnectMcpAction({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No active project/);
  });

  it("calls disconnectMcp with project-scoped key and revalidates layout", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    runDisconnectMock.mockResolvedValueOnce(undefined);
    const r = await disconnectMcpAction({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(true);
    expect(runDisconnectMock).toHaveBeenCalledWith("acme-notfair-googleads");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns error string when disconnect throws an Error", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    runDisconnectMock.mockRejectedValueOnce(new Error("openclaw blew up"));
    const r = await disconnectMcpAction({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/openclaw blew up/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns error string when disconnect throws a non-Error", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    runDisconnectMock.mockRejectedValueOnce("string thrown");
    const r = await disconnectMcpAction({ mcp_key: "notfair-googleads" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/string thrown/);
  });
});

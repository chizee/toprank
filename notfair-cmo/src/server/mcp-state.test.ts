import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenClawError } from "@/server/openclaw/cli";

// ── Mocks ──────────────────────────────────────────────────────────

const openclawMock = vi.fn();
vi.mock("@/server/openclaw/cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/openclaw/cli")>();
  return {
    ...actual,
    openclaw: (...args: unknown[]) => openclawMock(...args),
  };
});

const readMcpConfigRowMock = vi.fn();
const bearerFromHeadersMock = vi.fn();
const mcpRpcMock = vi.fn();
vi.mock("@/server/mcp/rpc", () => ({
  readMcpConfigRow: (...args: unknown[]) => readMcpConfigRowMock(...args),
  bearerFromHeaders: (...args: unknown[]) => bearerFromHeadersMock(...args),
  mcpRpc: (...args: unknown[]) => mcpRpcMock(...args),
}));

import { disconnectMcp, getMcpStatus, setMcpBearer } from "./mcp-state";

describe("getMcpStatus", () => {
  beforeEach(() => {
    readMcpConfigRowMock.mockReset();
    bearerFromHeadersMock.mockReset();
    mcpRpcMock.mockReset();
  });

  it("returns not_configured when no row", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce(null);
    await expect(getMcpStatus("k")).resolves.toEqual({ state: "not_configured" });
    expect(mcpRpcMock).not.toHaveBeenCalled();
  });

  it("returns not_configured when row has no url", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({ transport: "streamable-http" });
    await expect(getMcpStatus("k")).resolves.toEqual({ state: "not_configured" });
  });

  it("returns configured_no_token when row has url but no bearer", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({ url: "https://x", headers: {} });
    bearerFromHeadersMock.mockReturnValueOnce(null);
    await expect(getMcpStatus("k")).resolves.toEqual({
      state: "configured_no_token",
      url: "https://x",
    });
    expect(mcpRpcMock).not.toHaveBeenCalled();
  });

  it("returns connected with tools_count when probe succeeds with array of tools", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: true,
      result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({
      state: "connected",
      url: "https://x",
      tools_count: 3,
    });
    if (r.state === "connected") {
      expect(typeof r.last_checked_at).toBe("string");
      expect(new Date(r.last_checked_at).toString()).not.toBe("Invalid Date");
    }
  });

  it("returns connected with tools_count=null when result has no tools field", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({ ok: true, result: { something: "else" } });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "connected", tools_count: null });
  });

  it("returns connected with tools_count=null when tools is not an array", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: true,
      result: { tools: "not-an-array" },
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "connected", tools_count: null });
  });

  it("returns connected with tools_count=null when result is undefined", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({ ok: true, result: undefined });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "connected", tools_count: null });
  });

  it("returns stale_token on 401", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "http_error",
      status: 401,
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({
      state: "stale_token",
      url: "https://x",
      http_status: 401,
    });
  });

  it("returns stale_token on 403", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "http_error",
      status: 403,
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "stale_token", http_status: 403 });
  });

  it("returns unreachable HTTP 500 on other http_error", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "http_error",
      status: 500,
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "unreachable", error: "HTTP 500" });
  });

  it("returns unreachable on timeout", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({ ok: false, kind: "timeout" });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "unreachable", error: "timed out" });
  });

  it("returns unreachable on aborted", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({ ok: false, kind: "aborted" });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "unreachable", error: "aborted" });
  });

  it("returns unreachable on rpc_error with code + message", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "rpc_error",
      code: -32601,
      message: "Method not found",
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({
      state: "unreachable",
      error: "rpc error -32601: Method not found",
    });
  });

  it("returns unreachable on malformed_response", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "malformed_response",
      message: "empty body",
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({
      state: "unreachable",
      error: "malformed response: empty body",
    });
  });

  it("returns unreachable on network_error using the raw message", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({
      ok: false,
      kind: "network_error",
      message: "ECONNREFUSED",
    });
    const r = await getMcpStatus("k");
    expect(r).toMatchObject({ state: "unreachable", error: "ECONNREFUSED" });
  });

  it("passes the configured 2s timeout to mcpRpc", async () => {
    readMcpConfigRowMock.mockResolvedValueOnce({
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
    bearerFromHeadersMock.mockReturnValueOnce("t");
    mcpRpcMock.mockResolvedValueOnce({ ok: true, result: { tools: [] } });
    await getMcpStatus("k");
    expect(mcpRpcMock).toHaveBeenCalledWith(
      "https://x",
      "t",
      "tools/list",
      {},
      { timeoutMs: 2000 },
    );
  });
});

describe("disconnectMcp", () => {
  beforeEach(() => {
    openclawMock.mockReset();
  });

  it("calls `openclaw mcp unset <key>` with json:false", async () => {
    openclawMock.mockResolvedValueOnce(undefined);
    await disconnectMcp("acme-notfair-googleads");
    expect(openclawMock).toHaveBeenCalledWith(
      ["mcp", "unset", "acme-notfair-googleads"],
      { json: false },
    );
  });

  it("swallows OpenClawError when stderr says 'not found' (idempotent)", async () => {
    openclawMock.mockRejectedValueOnce(
      new OpenClawError("exited", "key not found in config", 1),
    );
    await expect(disconnectMcp("missing")).resolves.toBeUndefined();
  });

  it("swallows OpenClawError when stderr says 'unknown' (idempotent)", async () => {
    openclawMock.mockRejectedValueOnce(
      new OpenClawError("exited", "unknown mcp key", 1),
    );
    await expect(disconnectMcp("missing")).resolves.toBeUndefined();
  });

  it("re-throws OpenClawError with unrelated stderr", async () => {
    openclawMock.mockRejectedValueOnce(
      new OpenClawError("exited", "permission denied", 1),
    );
    await expect(disconnectMcp("k")).rejects.toBeInstanceOf(OpenClawError);
  });

  it("re-throws OpenClawError when stderr is empty", async () => {
    openclawMock.mockRejectedValueOnce(new OpenClawError("exited", "", 1));
    await expect(disconnectMcp("k")).rejects.toBeInstanceOf(OpenClawError);
  });

  it("re-throws non-OpenClawError errors unchanged", async () => {
    openclawMock.mockRejectedValueOnce(new TypeError("nope"));
    await expect(disconnectMcp("k")).rejects.toBeInstanceOf(TypeError);
  });

  it("is case-insensitive on 'not found' matching", async () => {
    openclawMock.mockRejectedValueOnce(
      new OpenClawError("exited", "Key NOT FOUND in openclaw.json", 1),
    );
    await expect(disconnectMcp("k")).resolves.toBeUndefined();
  });
});

describe("setMcpBearer", () => {
  beforeEach(() => {
    openclawMock.mockReset();
  });

  it("calls `openclaw mcp set <key> <json>` with streamable-http transport + bearer", async () => {
    openclawMock.mockResolvedValueOnce(undefined);
    await setMcpBearer("acme-notfair-googleads", "https://x/mcp", "tok-abc");
    expect(openclawMock).toHaveBeenCalledWith(
      [
        "mcp",
        "set",
        "acme-notfair-googleads",
        JSON.stringify({
          url: "https://x/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer tok-abc" },
        }),
      ],
      { json: false },
    );
  });

  it("propagates errors from the underlying openclaw call", async () => {
    openclawMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      setMcpBearer("k", "https://x", "t"),
    ).rejects.toThrow("disk full");
  });
});

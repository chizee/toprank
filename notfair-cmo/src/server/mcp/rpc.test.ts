import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenClawError } from "@/server/openclaw/cli";

const openclawMock = vi.fn();
vi.mock("@/server/openclaw/cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/openclaw/cli")>();
  return {
    ...actual,
    openclaw: (...args: unknown[]) => openclawMock(...args),
  };
});

import {
  bearerFromHeaders,
  getMcpConfig,
  mcpRpc,
  readMcpConfigRow,
} from "./rpc";

describe("bearerFromHeaders", () => {
  it("extracts bearer from Authorization header", () => {
    expect(bearerFromHeaders({ Authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("accepts lowercase 'authorization' key", () => {
    expect(bearerFromHeaders({ authorization: "Bearer xyz" })).toBe("xyz");
  });

  it("accepts case-mixed 'bearer' scheme", () => {
    expect(bearerFromHeaders({ Authorization: "bearer abc" })).toBe("abc");
    expect(bearerFromHeaders({ Authorization: "BEARER abc" })).toBe("abc");
  });

  it("returns null on undefined headers", () => {
    expect(bearerFromHeaders(undefined)).toBeNull();
  });

  it("returns null on empty headers", () => {
    expect(bearerFromHeaders({})).toBeNull();
  });

  it("returns null when scheme is not Bearer", () => {
    expect(bearerFromHeaders({ Authorization: "Basic abc" })).toBeNull();
  });

  it("trims trailing whitespace from token", () => {
    expect(bearerFromHeaders({ Authorization: "Bearer abc   " })).toBe("abc");
  });
});

describe("readMcpConfigRow", () => {
  beforeEach(() => {
    openclawMock.mockReset();
  });

  it("returns the row when openclaw succeeds", async () => {
    const row = {
      url: "https://example.com/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer t" },
    };
    openclawMock.mockResolvedValueOnce(row);
    await expect(readMcpConfigRow("test-key")).resolves.toEqual(row);
    expect(openclawMock).toHaveBeenCalledWith(["mcp", "show", "test-key"], {
      json: true,
    });
  });

  it("returns null when openclaw returns non-object", async () => {
    openclawMock.mockResolvedValueOnce(null);
    await expect(readMcpConfigRow("test-key")).resolves.toBeNull();
  });

  it("returns null when openclaw throws OpenClawError", async () => {
    openclawMock.mockRejectedValueOnce(new OpenClawError("unknown key", "", 1));
    await expect(readMcpConfigRow("missing-key")).resolves.toBeNull();
  });

  it("re-throws non-OpenClawError errors", async () => {
    openclawMock.mockRejectedValueOnce(new TypeError("totally different"));
    await expect(readMcpConfigRow("test-key")).rejects.toThrow(TypeError);
  });
});

describe("getMcpConfig", () => {
  beforeEach(() => {
    openclawMock.mockReset();
  });

  it("returns {url, token} when row has both", async () => {
    openclawMock.mockResolvedValueOnce({
      url: "https://example.com",
      headers: { Authorization: "Bearer t" },
    });
    await expect(getMcpConfig("k")).resolves.toEqual({
      url: "https://example.com",
      token: "t",
    });
  });

  it("returns null when row missing", async () => {
    openclawMock.mockResolvedValueOnce(null);
    await expect(getMcpConfig("k")).resolves.toBeNull();
  });

  it("returns null when row has url but no bearer", async () => {
    openclawMock.mockResolvedValueOnce({ url: "https://example.com" });
    await expect(getMcpConfig("k")).resolves.toBeNull();
  });

  it("returns null when row has bearer but no url", async () => {
    openclawMock.mockResolvedValueOnce({
      headers: { Authorization: "Bearer t" },
    });
    await expect(getMcpConfig("k")).resolves.toBeNull();
  });
});

describe("mcpRpc", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function sseResponse(status: number, frames: string[]): Response {
    const body = frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n";
    return new Response(body, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("returns {ok, result} on a successful JSON envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toEqual({ ok: true, result: { tools: [] } });
  });

  it("sends bearer auth header and JSON-RPC envelope in body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    await mcpRpc("http://x", "tok", "tools/call", { name: "X" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "X" },
    });
  });

  it("returns {ok, result} on SSE-framed response with final data: frame", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(200, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { partial: true } }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { final: true } }),
      ]),
    );
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toEqual({ ok: true, result: { final: true } });
  });

  it("returns rpc_error on JSON-RPC error envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      }),
    );
    const r = await mcpRpc("http://x", "tok", "nope");
    expect(r).toEqual({
      ok: false,
      kind: "rpc_error",
      code: -32601,
      message: "Method not found",
    });
  });

  it("returns http_error with 401 status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toEqual({ ok: false, kind: "http_error", status: 401 });
  });

  it("returns http_error with 500 status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("server fire", { status: 500 }));
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toEqual({ ok: false, kind: "http_error", status: 500 });
  });

  it("returns network_error when fetch throws (not abort)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toMatchObject({ ok: false, kind: "network_error" });
    if (!r.ok && r.kind === "network_error") {
      expect(r.message).toBe("fetch failed");
    }
  });

  it("returns timeout when our internal timer fires", async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const sig = (init as RequestInit).signal as AbortSignal;
          sig.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const r = await mcpRpc("http://x", "tok", "tools/list", {}, { timeoutMs: 10 });
    expect(r).toEqual({ ok: false, kind: "timeout" });
  });

  it("returns aborted when caller's signal fires before timeout", async () => {
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const sig = (init as RequestInit).signal as AbortSignal;
          sig.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const p = mcpRpc(
      "http://x",
      "tok",
      "tools/list",
      {},
      { timeoutMs: 60_000, signal: caller.signal },
    );
    caller.abort();
    await expect(p).resolves.toEqual({ ok: false, kind: "aborted" });
  });

  it("returns malformed_response on empty body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toMatchObject({ ok: false, kind: "malformed_response" });
  });

  it("returns malformed_response on invalid JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toMatchObject({ ok: false, kind: "malformed_response" });
  });

  it("returns malformed_response when envelope has neither result nor error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { jsonrpc: "2.0", id: 1 }),
    );
    const r = await mcpRpc("http://x", "tok", "tools/list");
    expect(r).toMatchObject({ ok: false, kind: "malformed_response" });
  });
});

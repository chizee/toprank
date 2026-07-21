import { describe, expect, it, vi } from "vitest";

import { handleJsonRpc, type McpServerInfo } from "./jsonrpc";
import type { ToolDefinition } from "./tools";
import { z } from "zod";

function makeTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "echo",
    description: "echoes",
    inputSchema: z.object({ text: z.string() }),
    handler: vi.fn(async () => ({
      ok: true as const,
      content: [{ type: "text" as const, text: "hi" }],
    })),
    ...over,
  };
}

function server(tools: ToolDefinition[]): McpServerInfo {
  return { name: "notfair-goals", version: "1.2.3", tools };
}

describe("handleJsonRpc", () => {
  it("returns null for notifications (no id)", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      server([]),
    );
    expect(res).toBeNull();
  });

  it("returns null when id is explicitly null", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: null, method: "initialize" },
      server([]),
    );
    expect(res).toBeNull();
  });

  it("answers initialize with protocol + serverInfo", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      server([]),
    );
    expect(res).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "notfair-goals", version: "1.2.3" },
        capabilities: { tools: {} },
      },
    });
  });

  it("answers tools/list with described tools", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: "a", method: "tools/list" },
      server([makeTool()]),
    );
    expect(res).toMatchObject({ id: "a" });
    const result = (res as { result: { tools: { name: string }[] } }).result;
    expect(result.tools[0]!.name).toBe("echo");
  });

  it("answers ping with an empty result", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      server([]),
    );
    expect(res).toMatchObject({ id: 2, result: {} });
  });

  it("returns -32601 for an unknown method", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 3, method: "does/not/exist" },
      server([]),
    );
    expect(res).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("executes tools/call and wraps ok results", async () => {
    const tool = makeTool();
    const res = await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "x" } },
      },
      server([tool]),
    );
    expect(tool.handler).toHaveBeenCalledWith({ text: "x" }, {});
    expect(res).toMatchObject({
      id: 4,
      result: { isError: false, content: [{ type: "text", text: "hi" }] },
    });
  });

  it("defaults arguments to {} when omitted", async () => {
    const tool = makeTool();
    await handleJsonRpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo" } },
      server([tool]),
    );
    expect(tool.handler).toHaveBeenCalledWith({}, {});
  });

  it("surfaces a failed tool result via isError:true", async () => {
    const tool = makeTool({
      handler: vi.fn(async () => ({ ok: false as const, error: "boom" })),
    });
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo" } },
      server([tool]),
    );
    expect(res).toMatchObject({
      id: 6,
      result: { isError: true, content: [{ type: "text", text: "boom" }] },
    });
  });

  it("returns -32602 when name is not a string", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: 123 } },
      server([makeTool()]),
    );
    expect(res).toMatchObject({ id: 7, error: { code: -32602 } });
  });

  it("returns -32601 for an unknown tool name", async () => {
    const res = await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "nope" },
      },
      server([makeTool()]),
    );
    expect(res).toMatchObject({
      id: 8,
      error: { code: -32601, message: expect.stringContaining("Unknown tool") },
    });
  });

  it("maps a throwing handler to -32603 internal error", async () => {
    const tool = makeTool({
      handler: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    });
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo" } },
      server([tool]),
    );
    expect(res).toMatchObject({
      id: 9,
      error: { code: -32603, message: expect.stringContaining("kaboom") },
    });
  });

  it("stringifies non-Error throws in the internal-error message", async () => {
    const tool = makeTool({
      handler: vi.fn(async () => {
        throw "stringy";
      }),
    });
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "echo" } },
      server([tool]),
    );
    expect(res).toMatchObject({
      id: 10,
      error: { code: -32603, message: expect.stringContaining("stringy") },
    });
  });
});

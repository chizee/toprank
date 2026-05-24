import { describeTool, findTool, TOOLS } from "./tools";

/**
 * JSON-RPC 2.0 dispatcher for notfair-cmo's outbound MCP server.
 *
 * MCP methods we implement:
 *   - initialize: handshake; reports protocol version + server info
 *   - tools/list: returns the available tool defs (name + JSON-schema)
 *   - tools/call: executes a named tool with arguments
 *
 * Notifications (no id) we no-op so older clients that send
 * `notifications/initialized` don't error.
 *
 * Auth is upstream of this dispatcher (the route checks the Bearer first);
 * callers reaching here are already authenticated.
 */

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

const PROTOCOL_VERSION = "2025-06-18";

export async function handleJsonRpc(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  // Notifications (no id): handle the side-effecting ones but never reply.
  if (req.id === undefined || req.id === null) {
    return null;
  }
  const id = req.id;

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "notfair-cmo", version: "0.1.0" },
          capabilities: { tools: {} },
        });
      case "tools/list":
        return ok(id, { tools: TOOLS.map(describeTool) });
      case "tools/call":
        return await handleToolsCall(id, req.params ?? {});
      case "ping":
        return ok(id, {});
      default:
        return err(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (cause) {
    return err(
      id,
      -32603,
      `Internal error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function handleToolsCall(
  id: string | number,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const name = params.name;
  const args = params.arguments ?? {};
  if (typeof name !== "string") {
    return err(id, -32602, "Invalid params: 'name' must be a string");
  }
  const tool = findTool(name);
  if (!tool) {
    return err(id, -32601, `Unknown tool: ${name}`);
  }
  // The handler does its own schema validation and returns a structured
  // result. For MCP tools/call, we surface errors via `isError: true` on the
  // result envelope (per spec) rather than as JSON-RPC errors, so the agent's
  // model sees the failure as a tool-call response it can react to.
  const result = await tool.handler(args, {});
  if (!result.ok) {
    return ok(id, {
      isError: true,
      content: [{ type: "text", text: result.error }],
    });
  }
  return ok(id, { isError: false, content: result.content });
}

function ok(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

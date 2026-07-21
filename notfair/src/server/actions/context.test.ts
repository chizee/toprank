import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  workspaceDirFor: vi.fn((id: string) => `/agents/${id}`),
  resolveSessionForThread: vi.fn(),
  listTranscriptEvents: vi.fn(),
  listProjectMcpTokens: vi.fn(),
  mcpRpcAutoRefresh: vi.fn(),
  getSecret: vi.fn(() => "loopback-secret"),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@/server/agents/provisioning", () => ({ workspaceDirFor: mocks.workspaceDirFor }));
vi.mock("@/server/sessions/transcript-tail", () => ({
  resolveSessionForThread: mocks.resolveSessionForThread,
}));
vi.mock("@/server/sessions/index", () => ({ listTranscriptEvents: mocks.listTranscriptEvents }));
vi.mock("@/server/mcp/tokens", () => ({ listProjectMcpTokens: mocks.listProjectMcpTokens }));
vi.mock("@/server/mcp/rpc", () => ({ mcpRpcAutoRefresh: mocks.mcpRpcAutoRefresh }));
vi.mock("@/server/mcp-server/secret", () => ({
  getOrCreateMcpServerSecret: mocks.getSecret,
}));

import { getGoalContextAction } from "./context";

function response(text: string) {
  return { text: vi.fn(async () => text) };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NOTFAIR_PORT;
  mocks.readFile.mockRejectedValue(new Error("missing"));
  mocks.listProjectMcpTokens.mockReturnValue([]);
  mocks.resolveSessionForThread.mockReturnValue(null);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("{}")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGoalContextAction", () => {
  it("splits shared context out of identity and estimates tokens", async () => {
    const identity = "# Identity\nintro\n## Shared workspace context\nAcme brief\n## Protocol\nDo work";
    mocks.readFile.mockResolvedValue(identity);
    const result = await getGoalContextAction({ project_slug: "acme", agent_id: "agent-1", thread: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chunks.map((c) => c.key)).toEqual(["identity", "shared-context"]);
    expect(result.chunks[0]!.content).toContain("## Protocol");
    expect(result.chunks[0]!.content).not.toContain("Acme brief");
    expect(result.chunks[1]!.content).toContain("Acme brief");
    expect(result.total_tokens).toBe(result.chunks.reduce((sum, c) => sum + c.tokens, 0));
  });

  it("handles shared context as the final identity section", async () => {
    mocks.readFile.mockResolvedValue("intro\n## Shared workspace context\nlast section");
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]!.content).toBe("intro");
  });

  it("keeps an identity without the marker as one chunk", async () => {
    mocks.readFile.mockResolvedValue("plain identity");
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" });
    if (!result.ok) throw new Error(result.error);
    expect(result.chunks).toMatchObject([{ key: "identity", content: "plain identity" }]);
  });

  it("collects loopback tools from JSON and SSE responses", async () => {
    process.env.NOTFAIR_PORT = "4444";
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(JSON.stringify({ result: { tools: [{ name: "goal", description: "d" }] } })) as never)
      .mockResolvedValueOnce(response("event: message\ndata:{\"result\":{\"tools\":[{\"name\":\"browser\"}]}}\n\n") as never);
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" });
    if (!result.ok) throw new Error(result.error);
    expect(result.chunks.map((c) => c.key)).toEqual(["tools:notfair-goals", "tools:notfair-browser"]);
    expect(result.chunks[0]).toMatchObject({ format: "json", group: "tools" });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4444/api/mcp/goals",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer loopback-secret" }),
      }),
    );
  });

  it("ignores empty, invalid, and failed internal tool responses", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response("event: message\nnot-data") as never)
      .mockRejectedValueOnce(new Error("offline"));
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" });
    expect(result).toEqual({ ok: true, chunks: [], total_tokens: 0 });
  });

  it("includes successful external MCP schemas and skips failures/empty lists", async () => {
    mocks.listProjectMcpTokens.mockReturnValue([
      { server_name: "one" },
      { server_name: "two" },
      { server_name: "three" },
    ]);
    mocks.mcpRpcAutoRefresh
      .mockResolvedValueOnce({ ok: true, result: { tools: [{ name: "search", inputSchema: { type: "object" } }] } })
      .mockResolvedValueOnce({ ok: false, kind: "timeout" })
      .mockResolvedValueOnce({ ok: true, result: { tools: [] } });
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" });
    if (!result.ok) throw new Error(result.error);
    expect(result.chunks.map((c) => c.key)).toEqual(["tools:one"]);
    expect(mocks.mcpRpcAutoRefresh).toHaveBeenCalledWith(
      "p", "one", "tools/list", {}, { timeoutMs: 10_000 },
    );
  });

  it("groups transcript events into briefs, user messages, replies, and tools", async () => {
    mocks.resolveSessionForThread.mockReturnValue({ id: "session-1" });
    mocks.listTranscriptEvents.mockReturnValue([
      { kind: "user", payload_json: JSON.stringify({ text: "[TICK] inspect", source: "goal-tick" }) },
      { kind: "user", payload_json: JSON.stringify({ text: "hello", source: "human" }) },
      { kind: "user", payload_json: "not-json" },
      { kind: "final", payload_json: JSON.stringify({ text: "done" }) },
      { kind: "final", payload_json: JSON.stringify({ text: 42 }) },
      { kind: "tool", payload_json: JSON.stringify({ name: "fetch" }) },
      { kind: "meta", payload_json: "{}" },
    ]);
    const result = await getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "thread-1" });
    if (!result.ok) throw new Error(result.error);
    expect(result.chunks.map((c) => c.key)).toEqual(["briefs", "user", "replies", "tool-activity"]);
    expect(result.chunks.find((c) => c.key === "user")?.content).toBe("hello");
    expect(result.chunks.find((c) => c.key === "tool-activity")?.format).toBe("json");
    expect(mocks.listTranscriptEvents).toHaveBeenCalledWith("session-1", { limit: 10_000 });
  });

  it.each([new Error("database down"), "unexpected"])("returns a safe top-level error for %#", async (failure) => {
    mocks.listProjectMcpTokens.mockImplementation(() => { throw failure; });
    await expect(getGoalContextAction({ project_slug: "p", agent_id: "a", thread: "t" })).resolves.toEqual({
      ok: false,
      error: failure instanceof Error ? failure.message : failure,
    });
  });
});

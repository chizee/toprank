import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/types";

const getActiveProjectMock = vi.fn();
vi.mock("@/server/active-project", () => ({
  getActiveProject: (...args: unknown[]) => getActiveProjectMock(...args),
}));

const getProjectMock = vi.fn();
vi.mock("@/server/db/projects", () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
}));

const resolveAgentBySlugMock = vi.fn();
vi.mock("@/server/agent-meta", () => ({
  resolveAgentBySlug: (...args: unknown[]) => resolveAgentBySlugMock(...args),
}));

const findSessionBySessionIdMock = vi.fn();
const buildPendingSessionKeyMock = vi.fn(
  (agent: string, sessionId: string) => `agent:${agent}:${sessionId}`,
);
vi.mock("@/server/openclaw/sessions", () => ({
  findSessionBySessionId: (...args: unknown[]) =>
    findSessionBySessionIdMock(...args),
  buildPendingSessionKey: (...args: unknown[]) =>
    buildPendingSessionKeyMock(...(args as [string, string])),
}));

const streamChatViaGatewayMock = vi.fn();
vi.mock("@/server/openclaw/gateway-client", () => ({
  streamChatViaGateway: (...args: unknown[]) => streamChatViaGatewayMock(...args),
}));

const getTaskMock = vi.fn();
const claimProposedTaskMock = vi.fn();
vi.mock("@/server/db/tasks", () => ({
  getTask: (...args: unknown[]) => getTaskMock(...args),
  claimProposedTask: (...args: unknown[]) => claimProposedTaskMock(...args),
}));

import { POST } from "./route";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "id",
    slug: "acme",
    display_name: "Acme",
    created_at: "now",
    archived_at: null,
    google_ads_account_id: null,
    website_url: null,
    codebase_path: null,
    ...overrides,
  };
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<{
  events: Array<{ event: string; data: unknown }>;
  raw: string;
}> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const events: Array<{ event: string; data: unknown }> = [];
  for (const chunk of raw.split("\n\n")) {
    const lines = chunk.split("\n");
    let event = "message";
    let data: unknown = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) {
        try {
          data = JSON.parse(line.slice("data: ".length));
        } catch {
          data = line.slice("data: ".length);
        }
      }
    }
    if (lines.length > 0 && lines[0]) events.push({ event, data });
  }
  return { events, raw };
}

// Stream-builder helper: yields the given events one at a time.
async function* makeAgentStream(
  evts: Array<{
    kind: "delta" | "tool" | "lifecycle" | "error" | "final";
    [k: string]: unknown;
  }>,
) {
  for (const e of evts) yield e;
}

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamChatViaGatewayMock.mockReset();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid JSON/);
  });

  it("returns 400 when message is missing", async () => {
    const res = await POST(makeReq({ sessionId: "s1" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/message is required/);
  });

  it("returns 400 when message is whitespace-only", async () => {
    const res = await POST(makeReq({ message: "   ", sessionId: "s1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when no active project resolves", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No active project/);
  });

  it("uses explicit project param over active-project cookie", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce(null); // short-circuit at 404

    const res = await POST(
      makeReq({ message: "hi", sessionId: "s1", project: "acme" }),
    );
    expect(res.status).toBe(404);
    expect(getProjectMock).toHaveBeenCalledWith("acme");
    expect(getActiveProjectMock).not.toHaveBeenCalled();
  });

  it("returns 404 when agent slug cannot be resolved", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ message: "hi", sessionId: "s1", agent: "ghost" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ghost/);
  });

  it("defaults agent to 'cmo' when not specified", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce(null);
    await POST(makeReq({ message: "hi", sessionId: "s1" }));
    expect(resolveAgentBySlugMock).toHaveBeenCalledWith("acme", "cmo");
  });

  it("returns 400 when sessionId is missing", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    const res = await POST(makeReq({ message: "hi" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId is required/);
  });

  it("uses provided sessionKey verbatim when present", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    streamChatViaGatewayMock.mockReturnValueOnce(makeAgentStream([]));
    const res = await POST(
      makeReq({
        message: "hello",
        sessionId: "s1",
        sessionKey: "agent:acme-cmo:custom-label",
      }),
    );
    expect(res.status).toBe(200);
    await readSse(res); // drain
    expect(streamChatViaGatewayMock).toHaveBeenCalledTimes(1);
    const call = streamChatViaGatewayMock.mock.calls[0]![0] as {
      sessionKey: string;
      sessionId: string;
      message: string;
    };
    expect(call.sessionKey).toBe("agent:acme-cmo:custom-label");
    expect(call.sessionId).toBe("s1");
    expect(call.message).toBe("hello");
    // No fallback lookup needed when sessionKey is explicit.
    expect(findSessionBySessionIdMock).not.toHaveBeenCalled();
  });

  it("looks up sessionKey from sessions store when not provided", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce({
      sessionId: "s1",
      sessionKey: "agent:acme-cmo:s1",
      label: "s1",
      lastInteractionAt: 0,
      pending: false,
    });
    streamChatViaGatewayMock.mockReturnValueOnce(makeAgentStream([]));
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    await readSse(res);
    expect(findSessionBySessionIdMock).toHaveBeenCalledWith("acme-cmo", "s1");
    const call = streamChatViaGatewayMock.mock.calls[0]![0] as {
      sessionKey: string;
    };
    expect(call.sessionKey).toBe("agent:acme-cmo:s1");
  });

  it("falls back to buildPendingSessionKey for unknown sessions", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    streamChatViaGatewayMock.mockReturnValueOnce(makeAgentStream([]));
    const res = await POST(makeReq({ message: "hi", sessionId: "new-id" }));
    await readSse(res);
    expect(buildPendingSessionKeyMock).toHaveBeenCalledWith(
      "acme-cmo",
      "new-id",
    );
    const call = streamChatViaGatewayMock.mock.calls[0]![0] as {
      sessionKey: string;
    };
    expect(call.sessionKey).toBe("agent:acme-cmo:new-id");
  });

  it("streams meta + text + done events for a happy-path chat", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    streamChatViaGatewayMock.mockReturnValueOnce(
      makeAgentStream([
        { kind: "delta", text: "Hello, " },
        { kind: "delta", text: "world!" },
      ]),
    );
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const { events } = await readSse(res);
    const eventNames = events.map((e) => e.event);
    expect(eventNames[0]).toBe("meta");
    expect(eventNames).toContain("text");
    expect(eventNames).toContain("done");

    const meta = events.find((e) => e.event === "meta")!.data as {
      project_slug: string;
      agent: string;
      session_id: string;
    };
    expect(meta.project_slug).toBe("acme");
    expect(meta.agent).toBe("acme-cmo");
    expect(meta.session_id).toBe("s1");

    const textEvents = events
      .filter((e) => e.event === "text")
      .map((e) => (e.data as { chunk: string }).chunk);
    expect(textEvents).toEqual(["Hello, ", "world!"]);
  });

  it("emits tool + lifecycle events through to the SSE stream", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    streamChatViaGatewayMock.mockReturnValueOnce(
      makeAgentStream([
        { kind: "lifecycle", phase: "start" },
        {
          kind: "tool",
          phase: "start",
          toolCallId: "tc1",
          name: "exec",
          label: "ls",
        },
        {
          kind: "tool",
          phase: "result",
          toolCallId: "tc1",
          name: "exec",
        },
        { kind: "lifecycle", phase: "end" },
      ]),
    );
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    const { events } = await readSse(res);

    const toolEvents = events.filter((e) => e.event === "tool");
    expect(toolEvents).toHaveLength(2);
    expect((toolEvents[0]!.data as { phase: string }).phase).toBe("start");
    expect((toolEvents[1]!.data as { phase: string }).phase).toBe("result");

    const lifecycleEvents = events.filter((e) => e.event === "lifecycle");
    expect(lifecycleEvents).toHaveLength(2);
  });

  it("emits an error event when the gateway stream yields an error", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    streamChatViaGatewayMock.mockReturnValueOnce(
      makeAgentStream([{ kind: "error", message: "gateway is down" }]),
    );
    // The route only invokes orchestration when assistantBuffer has content;
    // an error-only stream skips orchestration entirely.
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    const { events } = await readSse(res);
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect((errEvent!.data as { message: string }).message).toBe(
      "gateway is down",
    );
  });

  it("emits an error event when the gateway iterator throws", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);

    async function* throwingStream() {
      yield { kind: "delta" as const, text: "partial" };
      throw new Error("ws disconnected");
    }
    streamChatViaGatewayMock.mockReturnValueOnce(throwingStream());
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    const { events } = await readSse(res);
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect((errEvent!.data as { message: string }).message).toBe(
      "ws disconnected",
    );
  });

  // Orchestration side effects no longer run via post-stream regex parsing —
  // they happen via the notfair-orchestration MCP server while the agent's
  // turn is streaming. The chat route is now pure pipe + perf instrumentation,
  // so the only thing left to assert is that no `orchestration` SSE event is
  // ever emitted (it's no longer part of the protocol).
  // ── task_id: kickoff path ────────────────────────────────────────────
  describe("task_id (task kickoff)", () => {
    function setupAgent(slug = "acme", agentId = "acme-cmo") {
      getActiveProjectMock.mockResolvedValue(makeProject({ slug }));
      resolveAgentBySlugMock.mockResolvedValue({
        agent_id: agentId,
        display_name: "CMO",
        slug: "cmo",
      });
      findSessionBySessionIdMock.mockReturnValue(null);
    }

    it("claims a proposed task and proceeds to stream when task_id matches", async () => {
      setupAgent();
      getTaskMock.mockReturnValueOnce({
        id: "task-uuid",
        display_id: "acme-1",
        agent_id: "acme-cmo",
        status: "proposed",
      });
      claimProposedTaskMock.mockReturnValueOnce({
        id: "task-uuid",
        status: "working",
      });
      streamChatViaGatewayMock.mockReturnValueOnce(makeAgentStream([]));

      const res = await POST(
        makeReq({
          message: "(task assignment)",
          sessionId: "s1",
          task_id: "task-uuid",
        }),
      );
      expect(res.status).toBe(200);
      await readSse(res);
      expect(claimProposedTaskMock).toHaveBeenCalledWith("task-uuid");
      expect(streamChatViaGatewayMock).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when the task can't be claimed (already running/terminal)", async () => {
      setupAgent();
      getTaskMock.mockReturnValueOnce({
        id: "task-uuid",
        display_id: "acme-1",
        agent_id: "acme-cmo",
        status: "working",
      });
      claimProposedTaskMock.mockReturnValueOnce(null);

      const res = await POST(
        makeReq({ message: "hi", sessionId: "s1", task_id: "task-uuid" }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("working");
      // Should NOT stream when claim failed — otherwise we'd double-fire the
      // agent on a reload / concurrent tab.
      expect(streamChatViaGatewayMock).not.toHaveBeenCalled();
    });

    it("returns 404 when the task_id doesn't exist", async () => {
      setupAgent();
      getTaskMock.mockReturnValueOnce(null);
      const res = await POST(
        makeReq({ message: "hi", sessionId: "s1", task_id: "bogus" }),
      );
      expect(res.status).toBe(404);
      expect(claimProposedTaskMock).not.toHaveBeenCalled();
    });

    it("returns 400 when task belongs to a different agent", async () => {
      setupAgent("acme", "acme-cmo");
      getTaskMock.mockReturnValueOnce({
        id: "task-uuid",
        display_id: "acme-1",
        agent_id: "acme-google-ads",
        status: "proposed",
      });
      const res = await POST(
        makeReq({
          message: "hi",
          sessionId: "s1",
          agent: "cmo",
          task_id: "task-uuid",
        }),
      );
      expect(res.status).toBe(400);
      expect(claimProposedTaskMock).not.toHaveBeenCalled();
    });

    it("skips claim entirely when no task_id is provided (normal chat)", async () => {
      setupAgent();
      streamChatViaGatewayMock.mockReturnValueOnce(makeAgentStream([]));
      const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
      expect(res.status).toBe(200);
      await readSse(res);
      expect(getTaskMock).not.toHaveBeenCalled();
      expect(claimProposedTaskMock).not.toHaveBeenCalled();
    });
  });

  it("never emits an `orchestration` SSE event (MCP-based now)", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    findSessionBySessionIdMock.mockReturnValueOnce(null);
    streamChatViaGatewayMock.mockReturnValueOnce(
      makeAgentStream([{ kind: "delta", text: "Just chatting." }]),
    );
    const res = await POST(makeReq({ message: "hi", sessionId: "s1" }));
    const { events } = await readSse(res);
    expect(events.find((e) => e.event === "orchestration")).toBeUndefined();
    expect(events.find((e) => e.event === "done")).toBeDefined();
  });
});

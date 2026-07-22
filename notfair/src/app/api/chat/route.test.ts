import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessAdapter,
  HarnessExecuteContext,
  HarnessModelOption,
} from "@/server/adapters/types";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getActiveProject: vi.fn(),
  resolveAgentBySlug: vi.fn(),
  requireAdapter: vi.fn(),
  workspaceDirFor: vi.fn(() => "/tmp/notfair-agent"),
  getOrCreateSession: vi.fn(),
  appendTranscriptEvent: vi.fn(),
  touchSession: vi.fn(),
  registerLiveTurn: vi.fn(),
  releaseLiveTurn: vi.fn(),
}));

vi.mock("@/server/active-project", () => ({
  getActiveProject: mocks.getActiveProject,
}));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("@/server/agent-meta", () => ({
  resolveAgentBySlug: mocks.resolveAgentBySlug,
}));
vi.mock("@/server/adapters/registry", () => ({
  requireAdapter: mocks.requireAdapter,
}));
vi.mock("@/server/agents/provisioning", () => ({
  workspaceDirFor: mocks.workspaceDirFor,
}));
vi.mock("@/server/sessions", () => ({
  getOrCreateSession: mocks.getOrCreateSession,
  appendTranscriptEvent: mocks.appendTranscriptEvent,
  touchSession: mocks.touchSession,
}));
vi.mock("@/server/sessions/live-turns", () => ({
  registerLiveTurn: mocks.registerLiveTurn,
  releaseLiveTurn: mocks.releaseLiveTurn,
}));

import { POST } from "./route";

const models: HarnessModelOption[] = [
  {
    value: "gpt-dynamic",
    label: "Dynamic model",
    is_default: true,
    default_reasoning_effort: "low",
    reasoning_efforts: [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ],
  },
];

function request(body: unknown) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat reasoning effort", () => {
  let executeContext: HarnessExecuteContext | null;
  let adapter: Pick<HarnessAdapter, "listModels" | "execute">;

  beforeEach(() => {
    vi.clearAllMocks();
    executeContext = null;
    adapter = {
      listModels: vi.fn(async () => models),
      execute: vi.fn(async function* (ctx: HarnessExecuteContext) {
        executeContext = ctx;
      }),
    };
    mocks.getProject.mockReturnValue({
      slug: "acme",
      harness_adapter: "codex-local",
    });
    mocks.resolveAgentBySlug.mockResolvedValue({ agent_id: "goal-agent" });
    mocks.requireAdapter.mockReturnValue(adapter);
    mocks.getOrCreateSession.mockReturnValue({
      id: "session-1",
      harness_session_id: null,
    });
    mocks.registerLiveTurn.mockReturnValue(new AbortController());
  });

  it("validates and forwards a provider-supported effort without forcing a model", async () => {
    const response = await POST(
      request({
        project: "acme",
        agent: "goal-1",
        message: "hello",
        reasoning_effort: "high",
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(adapter.listModels).toHaveBeenCalledOnce();
    expect(executeContext).toMatchObject({
      model: null,
      reasoningEffort: "high",
    });
  });

  it("rejects an effort the selected model did not publish", async () => {
    const response = await POST(
      request({
        project: "acme",
        agent: "goal-1",
        message: "hello",
        reasoning_effort: "ultra-secret",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unknown reasoning effort 'ultra-secret' for model 'gpt-dynamic'",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("returns a 400 for a non-string effort instead of throwing", async () => {
    const response = await POST(
      request({
        project: "acme",
        agent: "goal-1",
        message: "hello",
        reasoning_effort: 42,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "reasoning_effort must be a string",
    });
    expect(adapter.listModels).not.toHaveBeenCalled();
  });
});

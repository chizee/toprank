import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getProject: vi.fn(),
  getOrCreateSession: vi.fn(),
  listAgentSessions: vi.fn(),
}));
vi.mock("@/server/db/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("./index", () => ({
  getOrCreateSession: mocks.getOrCreateSession,
  listAgentSessions: mocks.listAgentSessions,
}));

import {
  classifySessions,
  findSessionBySessionId,
  isSystemSession,
  listSessionsForAgent,
  materializeSession,
  newSessionId,
  pickLatestChatSession,
  type SessionView,
} from "./view";

const row = {
  id: "s1", label: "main", updated_at: "2026-01-02T00:00:00Z", title: "Title", pinned_at: "2026-01-01",
};

beforeEach(() => vi.clearAllMocks());

it("maps DB sessions to UI views", () => {
  mocks.listAgentSessions.mockReturnValue([row, { ...row, id: "s2", label: "other", updated_at: "bad", title: null, pinned_at: null }]);
  expect(listSessionsForAgent("p", "a")).toEqual([
    expect.objectContaining({ sessionId: "main", sessionKey: "s1", pending: false, pinned: true, title: "Title" }),
    expect.objectContaining({ sessionId: "other", lastInteractionAt: 0, pinned: false }),
  ]);
  expect(newSessionId()).toMatch(/^[0-9a-f-]{36}$/);
});

it("finds an owned session and handles missing rows", () => {
  const get = vi.fn().mockReturnValueOnce(row).mockReturnValueOnce(undefined);
  mocks.getDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });
  expect(findSessionBySessionId("p", "a", "main")).toMatchObject({ sessionKey: "s1" });
  expect(findSessionBySessionId("p", "a", "missing")).toBeNull();
  expect(get).toHaveBeenCalledWith("p", "a", "main");
});

it("materializes with the project harness or the default", () => {
  mocks.getOrCreateSession.mockReturnValue(row);
  mocks.getProject.mockReturnValue({ harness_adapter: "codex-local" });
  expect(materializeSession({ project_slug: "p", agent_id: "a", label: "main" })).toBe(row);
  expect(mocks.getOrCreateSession).toHaveBeenLastCalledWith(expect.objectContaining({ harness_adapter: "codex-local" }));
  mocks.getProject.mockReturnValue(null);
  materializeSession({ project_slug: "p", agent_id: "a", label: "other" });
  expect(mocks.getOrCreateSession).toHaveBeenLastCalledWith(expect.objectContaining({ harness_adapter: "claude-code-local" }));
});

it("detects tick sessions and picks the latest chat", () => {
  expect(isSystemSession("tick-12")).toBe(true);
  expect(isSystemSession("tick-x")).toBe(false);
  expect(pickLatestChatSession([{ label: "tick-2" }, { label: "main" }, { label: "other" }])).toEqual({ label: "main" });
  expect(pickLatestChatSession([{ label: "tick-2" }])).toBeUndefined();
});

it("classifies tick, pending, kickoff, normal, long, and malformed chats", async () => {
  const sessions: SessionView[] = [
    { sessionId: "tick-4", label: "tick-4", sessionKey: "1", lastInteractionAt: 0, pending: false, title: null, pinned: false },
    { sessionId: "pending", label: "pending", sessionKey: "2", lastInteractionAt: 0, pending: true, title: null, pinned: false },
    { sessionId: "kick", label: "kick", sessionKey: "3", lastInteractionAt: 0, pending: false, title: null, pinned: false },
    { sessionId: "chat", label: "chat", sessionKey: "4", lastInteractionAt: 0, pending: false, title: null, pinned: false },
    { sessionId: "long", label: "long", sessionKey: "5", lastInteractionAt: 0, pending: false, title: null, pinned: false },
    { sessionId: "missing", label: "missing", sessionKey: "6", lastInteractionAt: 0, pending: false, title: null, pinned: false },
    { sessionId: "bad", label: "bad", sessionKey: "7", lastInteractionAt: 0, pending: false, title: null, pinned: false },
  ];
  const payloadBySession: Record<string, unknown> = {
    kick: { payload_json: JSON.stringify({ text: "[INTAKE] begin" }) },
    chat: { payload_json: JSON.stringify({ text: "  Hello\n  world  " }) },
    long: { payload_json: JSON.stringify({ text: "x".repeat(150) }) },
    bad: { payload_json: "not-json" },
  };
  mocks.getDb.mockReturnValue({
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((...args: string[]) => {
        if (sql.includes("SELECT id FROM")) return args[2] === "missing" ? undefined : { id: args[2] };
        return payloadBySession[args[0]!];
      }),
    })),
  });
  const result = await classifySessions("a", "p", sessions);
  expect(result.get("tick-4")).toEqual({ kind: "tick", tick_number: 4 });
  expect(result.has("pending")).toBe(false);
  expect(result.get("kick")).toEqual({ kind: "chat", preview: "Goal kickoff" });
  expect(result.get("chat")).toEqual({ kind: "chat", preview: "Hello world" });
  expect((result.get("long") as { preview: string }).preview).toHaveLength(140);
  expect(result.get("missing")).toEqual({ kind: "chat", preview: "" });
  expect(result.get("bad")).toEqual({ kind: "chat", preview: "" });
  expect(await classifySessions("a", "p", [])).toEqual(new Map());
});

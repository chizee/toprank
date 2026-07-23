import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/server/db/db", () => ({ getDb: mocks.getDb }));

import { readTranscriptTail, resolveSessionForThread } from "./transcript-tail";

const session = { id: "session-1", project_slug: "acme", agent_id: "agent-1", label: "main" };

function dbWith(rows: Array<Record<string, unknown>>, found: unknown = session) {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => found),
      all: vi.fn(() => sql.includes("transcript_events") ? rows : []),
    })),
  };
}

beforeEach(() => vi.clearAllMocks());

it("resolves sessions with all ownership keys and returns null when absent", () => {
  let db = dbWith([], session);
  mocks.getDb.mockReturnValue(db);
  expect(resolveSessionForThread("acme", "agent-1", "main")).toBe(session);
  expect(db.prepare.mock.results[0]!.value.get).toHaveBeenCalledWith("acme", "agent-1", "main");
  mocks.getDb.mockReturnValue(dbWith([], null));
  expect(resolveSessionForThread("acme", "agent-1", "missing")).toBeNull();
});

it("returns the incoming cursor when no session exists", () => {
  mocks.getDb.mockReturnValue(dbWith([], null));
  expect(readTranscriptTail("p", "a", "t", 7)).toEqual({ events: [], cursor: 7 });
});

it("normalizes every transcript event kind and advances the cursor", () => {
  const rows = [
    { id: "u1", seq: 1, kind: "user", payload_json: '{"text":"hello","source":"human"}', created_at: "2026-01-01T00:00:00Z" },
    { id: "u2", seq: 2, kind: "user", payload_json: '{"text":"brief","source":"goal-tick"}', created_at: "bad" },
    { id: "d", seq: 3, kind: "delta", payload_json: '{"text":42}', created_at: "2026-01-01" },
    { id: "tc", seq: 4, kind: "tool", payload_json: '{"phase":"start","toolCallId":"c1","name":"search","label":"Searching"}', created_at: "2026-01-01" },
    { id: "tc2", seq: 5, kind: "tool", payload_json: '{}', created_at: "2026-01-01" },
    { id: "tr", seq: 6, kind: "tool", payload_json: '{"phase":"result","toolCallId":"c1","name":"search"}', created_at: "2026-01-01" },
    { id: "life", seq: 7, kind: "lifecycle", payload_json: '{}', created_at: "2026-01-01" },
    { id: "fin", seq: 8, kind: "final", payload_json: '{}', created_at: "2026-01-01" },
    { id: "err", seq: 9, kind: "error", payload_json: '{"message":"boom"}', created_at: "2026-01-01" },
    { id: "err2", seq: 10, kind: "error", payload_json: 'null', created_at: "2026-01-01" },
    { id: "x", seq: 11, kind: "other", payload_json: 'not json', created_at: "2026-01-01" },
  ];
  mocks.getDb.mockReturnValue(dbWith(rows));
  const result = readTranscriptTail("p", "a", "t", 0);
  expect(result.cursor).toBe(11);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "user_message", id: "u1", body: "hello", system: false }),
    expect.objectContaining({ kind: "user_message", id: "u2", system: true }),
    expect.objectContaining({ kind: "assistant_text", id: "d", body: "" }),
    expect.objectContaining({ kind: "tool_call", id: "tc", tool_call_id: "c1", label: "Searching" }),
    expect.objectContaining({ kind: "tool_call", id: "tc2", name: "tool", label: null }),
    expect.objectContaining({ kind: "tool_result", id: "tr", ok: true, summary: null }),
    expect.objectContaining({ kind: "lifecycle", id: "life", phase: "unknown" }),
    expect.objectContaining({
      kind: "lifecycle",
      id: "fin",
      phase: "done",
      ok: true,
    }),
    expect.objectContaining({ kind: "assistant_text", id: "err", body: "⚠ boom" }),
    expect.objectContaining({
      kind: "lifecycle",
      id: "err:done",
      phase: "done",
      ok: false,
    }),
    expect.objectContaining({ kind: "unknown", id: "x", raw_type: "other" }),
  ]));
  expect(result.events).toHaveLength(13);
});

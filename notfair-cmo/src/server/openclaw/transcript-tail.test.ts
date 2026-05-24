import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { tmpHome, ORIGINAL_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  const original = process.env.OPENCLAW_HOME;
  const tmp = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-transcript-"));
  process.env.OPENCLAW_HOME = tmp;
  return { tmpHome: tmp, ORIGINAL_HOME: original };
});

const findSessionMock = vi.fn();
vi.mock("@/server/openclaw/sessions", () => ({
  findSessionBySessionId: (...args: unknown[]) => findSessionMock(...args),
}));

import { resolveTranscriptPath, readTranscriptTail } from "./transcript-tail";
import { join } from "node:path";

function transcriptPath(agentFullId: string, sessionId: string): string {
  return join(tmpHome, "agents", agentFullId, "sessions", `${sessionId}.jsonl`);
}

function writeTranscript(agentFullId: string, sessionId: string, lines: string[]): string {
  const p = transcriptPath(agentFullId, sessionId);
  mkdirSync(join(tmpHome, "agents", agentFullId, "sessions"), { recursive: true });
  writeFileSync(p, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  return p;
}

function setSession(sessionId: string, label = sessionId): void {
  findSessionMock.mockReturnValue({
    sessionId,
    label,
    sessionKey: `agent:demo:${label}`,
    lastInteractionAt: 0,
    pending: false,
  });
}

describe("resolveTranscriptPath", () => {
  beforeEach(() => {
    findSessionMock.mockReset();
  });

  it("returns null when session not found", () => {
    findSessionMock.mockReturnValue(null);
    expect(resolveTranscriptPath("demo", "missing")).toBeNull();
  });

  it("returns null when file does not exist on disk", () => {
    setSession("sess-no-file");
    expect(resolveTranscriptPath("demo", "sess-no-file")).toBeNull();
  });

  it("returns the absolute path when session exists and file is on disk", () => {
    writeTranscript("demo", "sess-1", []);
    setSession("sess-1");
    expect(resolveTranscriptPath("demo", "sess-1")).toBe(transcriptPath("demo", "sess-1"));
  });
});

describe("readTranscriptTail", () => {
  beforeEach(() => {
    findSessionMock.mockReset();
  });

  it("returns empty events + same byteOffset when the file does not exist", () => {
    findSessionMock.mockReturnValue(null);
    const r = readTranscriptTail("demo", "x", 42);
    expect(r).toEqual({ events: [], byteOffset: 42, fileSize: 0 });
  });

  it("returns empty when byteOffset === fileSize (no new bytes)", () => {
    const lines = [JSON.stringify({ type: "message", id: "m1" })];
    writeTranscript("demo", "sess-2", lines);
    setSession("sess-2");
    const first = readTranscriptTail("demo", "sess-2", 0);
    expect(first.events.length).toBeGreaterThanOrEqual(0);
    const second = readTranscriptTail("demo", "sess-2", first.byteOffset);
    expect(second.events).toEqual([]);
    expect(second.byteOffset).toBe(first.byteOffset);
  });

  it("resets the byteOffset when it's beyond fileSize (rotation/truncation)", () => {
    writeTranscript("demo", "sess-3", [JSON.stringify({ type: "x" })]);
    setSession("sess-3");
    const r = readTranscriptTail("demo", "sess-3", 1_000_000);
    expect(r.events.length).toBe(1);
  });

  it("emits a user_message for role:user with string content", () => {
    writeTranscript("demo", "sess-4", [
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: 1700000000,
        message: { role: "user", content: "hello there" },
      }),
    ]);
    setSession("sess-4");
    const r = readTranscriptTail("demo", "sess-4", 0);
    expect(r.events.length).toBe(1);
    const e = r.events[0]!;
    expect(e.kind).toBe("user_message");
    if (e.kind === "user_message") {
      expect(e.body).toBe("hello there");
      expect(e.ts).toBe(1700000000);
    }
  });

  it("strips a timestamp prefix from user messages", () => {
    writeTranscript("demo", "sess-5", [
      JSON.stringify({
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: "[Mon 2026-05-19 09:00 PDT] real body",
        },
      }),
    ]);
    setSession("sess-5");
    const r = readTranscriptTail("demo", "sess-5", 0);
    const e = r.events[0]!;
    if (e.kind === "user_message") {
      expect(e.body).toBe("real body");
    }
  });

  it("emits user_message with array-of-text content joined", () => {
    writeTranscript("demo", "sess-6", [
      JSON.stringify({
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [
            { type: "text", text: "first" },
            "raw-string-part",
            { type: "text", text: "second" },
          ],
        },
      }),
    ]);
    setSession("sess-6");
    const r = readTranscriptTail("demo", "sess-6", 0);
    const e = r.events[0]!;
    if (e.kind === "user_message") {
      expect(e.body).toContain("first");
      expect(e.body).toContain("raw-string-part");
      expect(e.body).toContain("second");
    }
  });

  it("skips user messages whose body is empty after extraction", () => {
    writeTranscript("demo", "sess-empty-user", [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "" } }),
    ]);
    setSession("sess-empty-user");
    const r = readTranscriptTail("demo", "sess-empty-user", 0);
    expect(r.events).toEqual([]);
  });

  it("emits tool_result for top-level role:toolResult messages", () => {
    writeTranscript("demo", "sess-7", [
      JSON.stringify({
        type: "message",
        id: "tr1",
        timestamp: 1000,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "exec",
          isError: false,
          content: "stdout: ok",
        },
      }),
    ]);
    setSession("sess-7");
    const r = readTranscriptTail("demo", "sess-7", 0);
    expect(r.events.length).toBe(1);
    const e = r.events[0]!;
    expect(e.kind).toBe("tool_result");
    if (e.kind === "tool_result") {
      expect(e.tool_call_id).toBe("call-1");
      expect(e.ok).toBe(true);
      expect(e.summary).toBe("stdout: ok");
      expect(e.name).toBe("exec");
    }
  });

  it("marks isError:true toolResults as ok:false", () => {
    writeTranscript("demo", "sess-7-err", [
      JSON.stringify({
        type: "message",
        id: "tr1",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          isError: true,
          content: "boom",
        },
      }),
    ]);
    setSession("sess-7-err");
    const r = readTranscriptTail("demo", "sess-7-err", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_result") {
      expect(e.ok).toBe(false);
      expect(e.name).toBe("tool");
    }
  });

  it("skips toolResult messages without a toolCallId", () => {
    writeTranscript("demo", "sess-7-no-id", [
      JSON.stringify({
        type: "message",
        id: "tr1",
        message: { role: "toolResult", content: "x" },
      }),
    ]);
    setSession("sess-7-no-id");
    const r = readTranscriptTail("demo", "sess-7-no-id", 0);
    expect(r.events).toEqual([]);
  });

  it("emits assistant_text for assistant text-part content", () => {
    writeTranscript("demo", "sess-8", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Sure, here we go." },
          ],
        },
      }),
    ]);
    setSession("sess-8");
    const r = readTranscriptTail("demo", "sess-8", 0);
    expect(r.events.length).toBe(1);
    const e = r.events[0]!;
    expect(e.kind).toBe("assistant_text");
    if (e.kind === "assistant_text") expect(e.body).toBe("Sure, here we go.");
  });

  it("emits assistant_text for string parts in assistant content", () => {
    writeTranscript("demo", "sess-8-str", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: { role: "assistant", content: ["raw string body"] },
      }),
    ]);
    setSession("sess-8-str");
    const r = readTranscriptTail("demo", "sess-8-str", 0);
    expect(r.events[0]!.kind).toBe("assistant_text");
  });

  it("skips empty/whitespace text parts in assistant content", () => {
    writeTranscript("demo", "sess-8-blank", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "  " },
            "   ",
            { type: "text", text: "real" },
          ],
        },
      }),
    ]);
    setSession("sess-8-blank");
    const r = readTranscriptTail("demo", "sess-8-blank", 0);
    expect(r.events.length).toBe(1);
  });

  it("emits tool_call with command label for exec-shaped args", () => {
    writeTranscript("demo", "sess-9", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "exec",
              arguments: { command: "pnpm test\nfoo" },
            },
          ],
        },
      }),
    ]);
    setSession("sess-9");
    const r = readTranscriptTail("demo", "sess-9", 0);
    const e = r.events[0]!;
    expect(e.kind).toBe("tool_call");
    if (e.kind === "tool_call") {
      expect(e.label).toContain("pnpm test");
      expect(e.tool_call_id).toBe("call-1");
      expect(e.name).toBe("exec");
    }
  });

  it("falls back to JSON preview label when no known arg shape matches", () => {
    writeTranscript("demo", "sess-10", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-x",
              name: "unknown",
              arguments: { random: { nested: 1 } },
            },
          ],
        },
      }),
    ]);
    setSession("sess-10");
    const r = readTranscriptTail("demo", "sess-10", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_call") expect(e.label).toContain("random");
  });

  it("returns null label when toolCall has no args", () => {
    writeTranscript("demo", "sess-noargs", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-x", name: "x" }],
        },
      }),
    ]);
    setSession("sess-noargs");
    const r = readTranscriptTail("demo", "sess-noargs", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_call") expect(e.label).toBeNull();
  });

  it("uses input field when arguments missing on toolCall", () => {
    writeTranscript("demo", "sess-input", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              input: { path: "/foo/bar.ts" },
            },
          ],
        },
      }),
    ]);
    setSession("sess-input");
    const r = readTranscriptTail("demo", "sess-input", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_call") expect(e.label).toBe("/foo/bar.ts");
  });

  it("emits inline toolResult inside assistant content", () => {
    writeTranscript("demo", "sess-11", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolResult",
              toolCallId: "call-1",
              name: "exec",
              isError: false,
              content: [{ text: "result text" }],
            },
          ],
        },
      }),
    ]);
    setSession("sess-11");
    const r = readTranscriptTail("demo", "sess-11", 0);
    const e = r.events[0]!;
    expect(e.kind).toBe("tool_result");
    if (e.kind === "tool_result") {
      expect(e.tool_call_id).toBe("call-1");
      expect(e.summary).toBe("result text");
      expect(e.ok).toBe(true);
    }
  });

  it("uses tool_call_id (snake) and is_error (snake) as fallbacks", () => {
    writeTranscript("demo", "sess-snake", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolResult",
              tool_call_id: "snake-id",
              name: "x",
              is_error: true,
              output: "x output",
            },
          ],
        },
      }),
    ]);
    setSession("sess-snake");
    const r = readTranscriptTail("demo", "sess-snake", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_result") {
      expect(e.tool_call_id).toBe("snake-id");
      expect(e.ok).toBe(false);
      expect(e.summary).toBe("x output");
    }
  });

  it("emits an unknown event for non-message rows", () => {
    writeTranscript("demo", "sess-12", [
      JSON.stringify({ type: "session-meta", id: "m1", foo: "bar" }),
    ]);
    setSession("sess-12");
    const r = readTranscriptTail("demo", "sess-12", 0);
    const e = r.events[0]!;
    expect(e.kind).toBe("unknown");
    if (e.kind === "unknown") expect(e.raw_type).toBe("session-meta");
  });

  it("skips non-message entries with missing type (raw_type defaults to ?)", () => {
    writeTranscript("demo", "sess-noType", [JSON.stringify({ id: "m1", foo: 1 })]);
    setSession("sess-noType");
    const r = readTranscriptTail("demo", "sess-noType", 0);
    const e = r.events[0]!;
    if (e.kind === "unknown") expect(e.raw_type).toBe("?");
  });

  it("skips lines that are not valid JSON", () => {
    writeTranscript("demo", "sess-bad", [
      "not json",
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
    ]);
    setSession("sess-bad");
    const r = readTranscriptTail("demo", "sess-bad", 0);
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.kind).toBe("user_message");
  });

  it("only consumes up to the last newline (leaves partial line unconsumed)", () => {
    const p = transcriptPath("demo", "sess-partial");
    mkdirSync(join(tmpHome, "agents", "demo", "sessions"), { recursive: true });
    const completeLine =
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hello" } }) +
      "\n";
    const partial =
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: "world" } });
    writeFileSync(p, completeLine + partial, "utf8");
    setSession("sess-partial");
    const r = readTranscriptTail("demo", "sess-partial", 0);
    expect(r.events.length).toBe(1);
    expect(r.byteOffset).toBe(Buffer.byteLength(completeLine, "utf8"));
    expect(r.byteOffset).toBeLessThan(r.fileSize);
  });

  it("returns events:[] when buffer has no newline at all", () => {
    const p = transcriptPath("demo", "sess-noNL");
    mkdirSync(join(tmpHome, "agents", "demo", "sessions"), { recursive: true });
    writeFileSync(p, "no newline here", "utf8");
    setSession("sess-noNL");
    const r = readTranscriptTail("demo", "sess-noNL", 0);
    expect(r.events).toEqual([]);
    expect(r.byteOffset).toBe(0);
  });

  it("parses string timestamps via Date.parse", () => {
    writeTranscript("demo", "sess-tsstr", [
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      }),
    ]);
    setSession("sess-tsstr");
    const r = readTranscriptTail("demo", "sess-tsstr", 0);
    expect(r.events[0]!.ts).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("ts defaults to 0 when timestamp is missing", () => {
    writeTranscript("demo", "sess-nots", [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
    ]);
    setSession("sess-nots");
    const r = readTranscriptTail("demo", "sess-nots", 0);
    expect(r.events[0]!.ts).toBe(0);
  });

  it("skips messages with role other than user/assistant/toolResult", () => {
    writeTranscript("demo", "sess-role", [
      JSON.stringify({ type: "message", id: "x", message: { role: "system", content: "noise" } }),
    ]);
    setSession("sess-role");
    const r = readTranscriptTail("demo", "sess-role", 0);
    expect(r.events).toEqual([]);
  });

  it("skips message entries with no message body", () => {
    writeTranscript("demo", "sess-nobody", [JSON.stringify({ type: "message", id: "x" })]);
    setSession("sess-nobody");
    const r = readTranscriptTail("demo", "sess-nobody", 0);
    expect(r.events).toEqual([]);
  });

  it("uses url label when toolCall has url arg", () => {
    writeTranscript("demo", "sess-url", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "fetch",
              arguments: { url: "https://example.com/api" },
            },
          ],
        },
      }),
    ]);
    setSession("sess-url");
    const r = readTranscriptTail("demo", "sess-url", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_call") expect(e.label).toBe("https://example.com/api");
  });

  it("summarizes string content for inline toolResult", () => {
    writeTranscript("demo", "sess-strsum", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolResult",
              toolCallId: "c1",
              content: "single string output",
            },
          ],
        },
      }),
    ]);
    setSession("sess-strsum");
    const r = readTranscriptTail("demo", "sess-strsum", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_result") expect(e.summary).toBe("single string output");
  });

  it("returns null summary when toolResult content is null/empty array", () => {
    writeTranscript("demo", "sess-nullsum", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "toolResult", toolCallId: "c1", content: [] }],
        },
      }),
    ]);
    setSession("sess-nullsum");
    const r = readTranscriptTail("demo", "sess-nullsum", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_result") expect(e.summary).toBeNull();
  });

  it("summarizes object content as JSON preview", () => {
    writeTranscript("demo", "sess-objsum", [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolResult",
              toolCallId: "c1",
              content: { ok: true, lines: 42 },
            },
          ],
        },
      }),
    ]);
    setSession("sess-objsum");
    const r = readTranscriptTail("demo", "sess-objsum", 0);
    const e = r.events[0]!;
    if (e.kind === "tool_result") expect(e.summary).toMatch(/ok/);
  });
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
});

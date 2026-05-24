import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "@/server/openclaw/gateway-client";
import { rawEntryToEvents } from "@/server/openclaw/transcript-tail";

// Pin the data dir BEFORE importing shadow-transcript so the path
// helper resolves inside the tmpdir. The module reads
// process.env.NOTFAIR_CMO_DATA_DIR lazily on each call, so it picks up
// the value set here.
const tmpRoot = mkdtempSync(join(tmpdir(), "notfair-cmo-shadow-"));
process.env.NOTFAIR_CMO_DATA_DIR = tmpRoot;

import {
  openShadowWriter,
  readShadowFromOffset,
  shadowStreamEvent,
  shadowTranscriptExists,
  shadowTranscriptPath,
} from "./shadow-transcript";

const AGENT = "demo-cmo-greg";
const THREAD = "thread-xyz";

function readShadowFile(): string {
  try {
    return readFileSync(shadowTranscriptPath(AGENT, THREAD), "utf8");
  } catch {
    return "";
  }
}

function shadowLines(): Array<Record<string, unknown>> {
  return readShadowFile()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(async () => {
  // Each test starts with a clean shadow file. The tmpRoot itself
  // persists across tests (afterAll cleans it up) so we don't keep
  // recreating new tmpdirs.
  await rm(shadowTranscriptPath(AGENT, THREAD), { force: true });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("shadowTranscriptPath + shadowTranscriptExists", () => {
  it("resolves under the data dir", () => {
    const p = shadowTranscriptPath(AGENT, THREAD);
    expect(p).toBe(join(tmpRoot, "agents", AGENT, "shadow", `${THREAD}.jsonl`));
  });

  it("exists() is false before any write", () => {
    expect(shadowTranscriptExists(AGENT, THREAD)).toBe(false);
  });
});

describe("openShadowWriter — basic message writing", () => {
  it("flushes accumulated deltas as a single assistant message", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("hello ");
    w.appendDelta("world");
    await w.flushAssistant();
    await w.close();

    const lines = shadowLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.type).toBe("message");
    expect(line.id).toMatch(/^shadow-/);
    expect(typeof line.timestamp).toBe("string");
    const msg = line.message as { role: string; content: Array<{ type: string; text: string }> };
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("flushAssistant on an empty buffer is a no-op (no file write)", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await w.flushAssistant();
    await w.close();
    expect(shadowLines()).toHaveLength(0);
  });

  it("close() flushes any pending assistant text", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("a final thought");
    // Note: NO explicit flushAssistant; close() must commit.
    await w.close();
    const lines = shadowLines();
    expect(lines).toHaveLength(1);
    const msg = (lines[0] as { message: { content: Array<{ text: string }> } })
      .message;
    expect(msg.content[0]!.text).toBe("a final thought");
  });

  it("replaceAssistant overwrites the buffer (single committed message)", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("partial deltas...");
    // The gateway's `final` event carries the canonical cumulative text;
    // replaceAssistant is how we make `final` authoritative without
    // double-counting the deltas we already saw.
    w.replaceAssistant("the canonical final reply");
    await w.flushAssistant();
    await w.close();

    const lines = shadowLines();
    expect(lines).toHaveLength(1);
    const msg = (lines[0] as { message: { content: Array<{ text: string }> } })
      .message;
    expect(msg.content[0]!.text).toBe("the canonical final reply");
  });
});

describe("openShadowWriter — tool calls + results", () => {
  it("toolStart flushes pending assistant text first, then writes the tool call", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("looking up the data");
    await w.toolStart("tc-1", "ads.gaql", "SELECT name FROM customer");
    await w.close();

    const lines = shadowLines();
    expect(lines).toHaveLength(2);
    // Order matters — assistant text before tool call.
    const firstMsg = (
      lines[0] as { message: { role: string; content: Array<{ text: string }> } }
    ).message;
    expect(firstMsg.role).toBe("assistant");
    expect(firstMsg.content[0]!.text).toBe("looking up the data");

    const secondMsg = (
      lines[1] as {
        message: {
          role: string;
          content: Array<{
            type: string;
            id: string;
            name: string;
            arguments?: { __label?: string };
          }>;
        };
      }
    ).message;
    expect(secondMsg.role).toBe("assistant");
    expect(secondMsg.content[0]!.type).toBe("toolCall");
    expect(secondMsg.content[0]!.id).toBe("tc-1");
    expect(secondMsg.content[0]!.name).toBe("ads.gaql");
    expect(secondMsg.content[0]!.arguments?.__label).toBe(
      "SELECT name FROM customer",
    );
  });

  it("toolResult writes a toolResult message keyed by tool_call_id", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await w.toolResult("tc-1", "ads.gaql", true, "5 rows");
    await w.toolResult("tc-2", "ads.gaql", false);
    await w.close();

    const lines = shadowLines();
    expect(lines).toHaveLength(2);

    const ok = (lines[0] as {
      message: {
        role: string;
        toolCallId: string;
        toolName: string;
        isError: boolean;
        content: Array<{ text: string }>;
      };
    }).message;
    expect(ok.role).toBe("toolResult");
    expect(ok.toolCallId).toBe("tc-1");
    expect(ok.toolName).toBe("ads.gaql");
    expect(ok.isError).toBe(false);
    expect(ok.content[0]!.text).toBe("5 rows");

    const err = (lines[1] as {
      message: {
        role: string;
        toolCallId: string;
        isError: boolean;
        content?: unknown;
      };
    }).message;
    expect(err.toolCallId).toBe("tc-2");
    expect(err.isError).toBe(true);
    expect(err.content).toBeUndefined();
  });
});

describe("shadowStreamEvent — gateway → shadow translation", () => {
  it("delta events buffer; flushAssistant emits one message", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await shadowStreamEvent(w, { kind: "delta", text: "hel" } as ChatStreamEvent);
    await shadowStreamEvent(w, { kind: "delta", text: "lo" } as ChatStreamEvent);
    await w.flushAssistant();
    await w.close();
    const lines = shadowLines();
    expect(lines).toHaveLength(1);
    const msg = (lines[0] as { message: { content: Array<{ text: string }> } }).message;
    expect(msg.content[0]!.text).toBe("hello");
  });

  it("final events REPLACE the delta buffer — no double-write (Bug 2 regression)", async () => {
    // Reproduces the bug: provider emits deltas + a cumulative `final`.
    // Naive append would commit "hello world" then again "hello world",
    // producing two assistant messages in the shadow.
    const w = await openShadowWriter(AGENT, THREAD);
    await shadowStreamEvent(w, { kind: "delta", text: "hello " } as ChatStreamEvent);
    await shadowStreamEvent(w, { kind: "delta", text: "world" } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "final",
      text: "hello world",
    } as ChatStreamEvent);
    await w.close();

    const lines = shadowLines();
    // ONE message, not two.
    expect(lines).toHaveLength(1);
    const msg = (lines[0] as { message: { content: Array<{ text: string }> } }).message;
    expect(msg.content[0]!.text).toBe("hello world");
  });

  it("tool start + result events route to writer methods", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await shadowStreamEvent(w, {
      kind: "tool",
      phase: "start",
      toolCallId: "tc-9",
      name: "exec",
      label: "ls -la",
    } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "tool",
      phase: "result",
      toolCallId: "tc-9",
      name: "exec",
      label: "done",
    } as ChatStreamEvent);
    await w.close();
    const lines = shadowLines();
    expect(lines).toHaveLength(2);
    const first = (
      lines[0] as { message: { content: Array<{ type: string; id: string }> } }
    ).message;
    expect(first.content[0]!.type).toBe("toolCall");
    expect(first.content[0]!.id).toBe("tc-9");
    const second = (lines[1] as { message: { role: string; toolCallId: string } })
      .message;
    expect(second.role).toBe("toolResult");
    expect(second.toolCallId).toBe("tc-9");
  });

  it("lifecycle + error events are skipped (no shadow side-effects)", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await shadowStreamEvent(w, {
      kind: "lifecycle",
      phase: "start",
    } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "error",
      message: "boom",
    } as ChatStreamEvent);
    await w.close();
    expect(shadowLines()).toHaveLength(0);
  });
});

describe("readShadowFromOffset", () => {
  it("returns empty for a missing file without throwing", async () => {
    const r = await readShadowFromOffset(AGENT, "no-such-thread", 0);
    expect(r).toEqual({ bytes: "", byteOffset: 0, fileSize: 0 });
  });

  it("returns the new bytes since the supplied byteOffset", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("first");
    await w.flushAssistant();
    const after1 = await readShadowFromOffset(AGENT, THREAD, 0);
    expect(after1.bytes.length).toBeGreaterThan(0);
    expect(after1.byteOffset).toBe(after1.fileSize);

    // Append a second event; calling with the prior byteOffset should
    // return only the new line.
    w.appendDelta("second");
    await w.flushAssistant();
    const after2 = await readShadowFromOffset(AGENT, THREAD, after1.byteOffset);
    expect(after2.bytes.length).toBeGreaterThan(0);
    expect(after2.bytes).toContain("second");
    expect(after2.bytes).not.toContain("first");
    await w.close();
  });

  it("truncation resets the offset (defensive — file rotated/cleared)", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("one");
    await w.flushAssistant();
    const offsetPastEnd = 9999;
    const r = await readShadowFromOffset(AGENT, THREAD, offsetPastEnd);
    // byteOffset higher than fileSize ⇒ reset to 0 + read everything.
    expect(r.bytes).toContain("one");
    await w.close();
  });

  it("only consumes complete lines — a partial trailing line stays unconsumed", async () => {
    // Build the file by hand to simulate a writer mid-append. The
    // appendFile path always writes a full JSON+\n line atomically per
    // call, so this is a pathological case; the parser must still be
    // resilient against it.
    const w = await openShadowWriter(AGENT, THREAD);
    w.appendDelta("a complete line");
    await w.flushAssistant();
    await w.close();

    // Manually splice a partial line on at the end.
    const fs = await import("node:fs/promises");
    await fs.appendFile(
      shadowTranscriptPath(AGENT, THREAD),
      '{"partial":"no newline yet"',
      "utf8",
    );
    const r = await readShadowFromOffset(AGENT, THREAD, 0);
    // The complete line ends in \n; the partial bytes after the last \n
    // must NOT be in `bytes` — they'll be picked up on a later poll once
    // the writer finishes.
    expect(r.bytes.endsWith("\n")).toBe(true);
    expect(r.bytes).not.toContain("partial");
    expect(r.byteOffset).toBeLessThan(r.fileSize);
  });
});

describe("end-to-end: shadow lines round-trip through rawEntryToEvents", () => {
  it("produces TranscriptEvents the polling path already knows how to render", async () => {
    const w = await openShadowWriter(AGENT, THREAD);
    await shadowStreamEvent(w, { kind: "delta", text: "thinking..." } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "tool",
      phase: "start",
      toolCallId: "tc-1",
      name: "ads.gaql",
      label: "SELECT 1",
    } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "tool",
      phase: "result",
      toolCallId: "tc-1",
      name: "ads.gaql",
      label: "ok",
    } as ChatStreamEvent);
    await shadowStreamEvent(w, {
      kind: "final",
      text: "done — final answer",
    } as ChatStreamEvent);
    await w.close();

    const events = shadowLines().flatMap((line, idx) => {
      const raw = line as Parameters<typeof rawEntryToEvents>[0];
      return rawEntryToEvents(raw, `${raw.id ?? "anon"}-${idx}`);
    });

    // We expect (in order):
    //   1. assistant_text "thinking..." — flushed by toolStart
    //   2. tool_call tc-1
    //   3. tool_result tc-1
    //   4. assistant_text "done — final answer" — from `final` via replace
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "assistant_text",
      "tool_call",
      "tool_result",
      "assistant_text",
    ]);
    const finalText = events[3] as { kind: "assistant_text"; body: string };
    expect(finalText.body).toBe("done — final answer");
    const toolCall = events[1] as {
      kind: "tool_call";
      tool_call_id: string;
      name: string;
    };
    expect(toolCall.tool_call_id).toBe("tc-1");
    expect(toolCall.name).toBe("ads.gaql");
    const toolResult = events[2] as {
      kind: "tool_result";
      tool_call_id: string;
      ok: boolean;
    };
    expect(toolResult.tool_call_id).toBe("tc-1");
    expect(toolResult.ok).toBe(true);
  });
});

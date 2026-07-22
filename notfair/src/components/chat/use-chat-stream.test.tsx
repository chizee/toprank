// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStream } from "./use-chat-stream";
import type { TranscriptEvent } from "@/server/sessions/transcript-tail";

const base = {
  projectSlug: "acme co",
  agentSlug: "goal-1",
  threadId: "main",
  initialEvents: [] as TranscriptEvent[],
  initialCursor: 0,
  model: "",
  reasoningEffort: "",
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
  close = vi.fn();
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener) {
    const entries = this.listeners.get(name) ?? [];
    entries.push(listener as (event: MessageEvent) => void);
    this.listeners.set(name, entries);
  }

  emit(name: string, data = "") {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data }));
    }
  }
}

function pollResponse(events: TranscriptEvent[] = [], cursor = 0) {
  return {
    ok: true,
    json: vi.fn(async () => ({ events, cursor })),
  };
}

function streamResponse(chunks: string[], afterChunks?: Promise<void>) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (index < chunks.length) return { value: encoder.encode(chunks[index++]!), done: false };
          if (afterChunks) await afterChunks;
          return { value: undefined, done: true };
        }),
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pollResponse()));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  vi.spyOn(console, "groupEnd").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exposes initial events, derives remote-turn state, and clears the local view", () => {
  const now = Date.now();
  const initialEvents: TranscriptEvent[] = [
    { kind: "lifecycle", id: "start", ts: now, phase: "start" },
    { kind: "assistant_text", id: "delta", ts: now + 1, body: "working" },
  ];
  const { result } = renderHook(() => useChatStream({ ...base, initialEvents, initialCursor: 2 }));
  expect(result.current.events).toEqual(initialEvents);
  expect(result.current.openTurn).toMatchObject({ startedAt: now });
  expect(result.current.remoteTurnActive).toBe(true);
  act(() => result.current.clearLocal());
  expect(result.current.events).toEqual([]);
  expect(result.current.openTurn).toBeNull();
});

it("polls, advances the cursor, and only deduplicates durable event ids", async () => {
  vi.useFakeTimers();
  const original: TranscriptEvent = { kind: "assistant_text", id: "one", ts: 1, body: "same" };
  const repeated: TranscriptEvent = { kind: "assistant_text", id: "two", ts: 2, body: "same" };
  const fresh: TranscriptEvent = { kind: "assistant_text", id: "three", ts: 3, body: "fresh" };
  vi.mocked(fetch).mockResolvedValue(
    pollResponse([
      original,
      repeated,
      fresh,
    ], 3) as never,
  );
  const { result } = renderHook(() => useChatStream({ ...base, initialEvents: [original], initialCursor: 1 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(result.current.events).toEqual([original, repeated, fresh]);
  expect(fetch).toHaveBeenCalledWith(
    "/api/agents/goal-1/threads/main/transcript?offset=1&project=acme%20co",
    { cache: "no-store" },
  );
});

it("ignores failed and throwing polls", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: false } as Response)
    .mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useChatStream(base));
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(result.current.events).toEqual([]);
});

it("merges live bridge events, rejects bad payloads, logs lifecycle events, and closes", () => {
  const { result, unmount } = renderHook(() => useChatStream(base));
  const source = FakeEventSource.instances[0]!;
  expect(source.url).toContain("/live?project=acme%20co");
  act(() => {
    source.emit("open");
    source.emit("ready", "ready");
    source.emit("transcript", "not json");
    source.emit("transcript", JSON.stringify({ events: "bad" }));
    source.emit("error", "oops");
    source.emit("transcript", JSON.stringify({
      events: [{ kind: "assistant_text", id: "live-1", ts: 1, body: "live" }],
    }));
  });
  expect(result.current.events).toMatchObject([{ id: "live-1", body: "live" }]);
  unmount();
  expect(source.close).toHaveBeenCalled();
});

it("skips the bridge when EventSource is unavailable", () => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pollResponse()));
  renderHook(() => useChatStream(base));
  expect(FakeEventSource.instances).toHaveLength(0);
});

it("streams text, tools, lifecycle, error, meta, and perf events", async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const sse = [
    'event: text\ndata: {"chunk":"Hello "}',
    'event: text\ndata: {"chunk":"world"}',
    'event: tool\ndata: {"phase":"start","tool_call_id":"tc1","name":"search","label":"Searching"}',
    'event: tool\ndata: {"phase":"result","tool_call_id":"tc1","name":"search"}',
    'event: lifecycle\ndata: {"phase":"run.warming"}',
    'event: error\ndata: {"message":"soft warning"}',
    'event: meta\ndata: {"agent":"a","session_id":"s","message_chars":5,"is_kickoff":true}',
    'event: perf\ndata: {"marks":[{"name":"done","at":10.4,"delta":2.6}]}',
  ].join("\n\n") + "\n\n";
  vi.mocked(fetch).mockImplementation((url) => {
    if (url === "/api/chat") return Promise.resolve(streamResponse([sse], blocked) as never);
    return Promise.resolve(pollResponse() as never);
  });
  const { result } = renderHook(() =>
    useChatStream({ ...base, model: "gpt-test", reasoningEffort: "xhigh" }),
  );
  let sendPromise!: ReturnType<typeof result.current.send>;
  act(() => { sendPromise = result.current.send("hello"); });
  await waitFor(() => expect(result.current.pendingAssistant).toBe("Hello world"));
  expect(result.current.sendingChat).toBe(true);
  expect(result.current.pendingUserMsg).toBe("hello");
  expect(result.current.pendingTools).toMatchObject([{ toolCallId: "tc1", done: true }]);
  expect(result.current.pendingLifecycle).toBe("run.warming");
  expect(result.current.pendingError).toBe("soft warning");
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([u]) => u === "/api/chat")?.[1]?.body))).toMatchObject({
    message: "hello",
    model: "gpt-test",
    reasoning_effort: "xhigh",
  });
  finish();
  await act(async () => {
    await sendPromise;
  });
  expect(result.current.sendingChat).toBe(false);
  expect(result.current.pendingLifecycle).toBeNull();
  expect(console.groupCollapsed).toHaveBeenCalled();
});

it("supports hidden sends and clears optimistic state when polling catches up", async () => {
  vi.useFakeTimers();
  const committed: TranscriptEvent = { kind: "assistant_text", id: "db-1", ts: 2, body: "done" };
  vi.mocked(fetch)
    .mockResolvedValueOnce(streamResponse([]) as never)
    .mockResolvedValueOnce(pollResponse([committed], 1) as never);
  const { result } = renderHook(() => useChatStream(base));
  let promise!: ReturnType<typeof result.current.send>;
  act(() => { promise = result.current.send("secret", { hidden: true }); });
  expect(result.current.pendingUserMsg).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    await promise;
  });
  expect(result.current.events).toEqual([committed]);
  expect(result.current.pendingAssistant).toBe("");
});

it("returns response and thrown errors to the caller", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 503,
    body: {},
    text: vi.fn(async () => "server sad"),
  } as never);
  const { result } = renderHook(() => useChatStream(base));
  await act(async () => {
    await expect(result.current.send("hello")).resolves.toEqual({ error: "server sad" });
  });
  expect(result.current.pendingError).toBe("server sad");

  vi.mocked(fetch).mockRejectedValueOnce("string failure");
  await act(async () => {
    await expect(result.current.send("again")).resolves.toEqual({ error: "string failure" });
  });
});

it("ignores empty/concurrent sends and stops both the local and server turn", async () => {
  let rejectChat!: (error: unknown) => void;
  vi.mocked(fetch).mockImplementation((url, init) => {
    if (url === "/api/chat/stop") return Promise.reject(new Error("best effort"));
    if (url === "/api/chat") {
      return new Promise((_resolve, reject) => {
        rejectChat = reject;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(pollResponse() as never);
  });
  const { result } = renderHook(() => useChatStream(base));
  await expect(result.current.send("")).resolves.toBeUndefined();
  let first!: ReturnType<typeof result.current.send>;
  act(() => { first = result.current.send("go"); });
  await waitFor(() => expect(result.current.sendingChat).toBe(true));
  await expect(result.current.send("duplicate")).resolves.toBeUndefined();
  act(() => result.current.stopTurn());
  await act(async () => { await first; });
  expect(result.current.sendingChat).toBe(false);
  expect(fetch).toHaveBeenCalledWith("/api/chat/stop", expect.objectContaining({
    body: JSON.stringify({ project: "acme co", agent: "goal-1", thread: "main" }),
  }));
  void rejectChat;
});

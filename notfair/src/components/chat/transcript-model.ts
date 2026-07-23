import type { TranscriptEvent } from "@/server/sessions/transcript-tail";

/**
 * The chat's data model: how raw transcript events become the rendered
 * conversation, plus the SSE wire-format parsing for an active send.
 * Pure functions and types only — no React in this file.
 */

export type ToolEntry = {
  toolCallId: string;
  name: string;
  label: string | null;
  result: string | null;
  ok: boolean;
  done: boolean;
};

export type RenderedItem =
  | { kind: "user_message"; key: string; body: string; system?: boolean }
  | { kind: "assistant_text"; key: string; body: string }
  | { kind: "tool_group"; key: string; tools: ToolEntry[] }
  | { kind: "system_unknown"; key: string; raw_type: string };

/**
 * Stable across the optimistic SSE row and its committed transcript copy.
 * Harnesses may restart tool ids (for example `item_1`) on every turn, so
 * later occurrences need a suffix to remain unique within a long chat.
 */
export function toolGroupKey(toolCallId: string, occurrence = 0): string {
  return occurrence === 0
    ? `tg:${toolCallId}`
    : `tg:${toolCallId}:${occurrence}`;
}

/** Match the pending tool card to the key its committed group will receive. */
export function nextToolGroupKey(
  rendered: RenderedItem[],
  toolCallId: string,
): string {
  const occurrence = rendered.filter(
    (item) =>
      item.kind === "tool_group" &&
      item.tools[0]?.toolCallId === toolCallId,
  ).length;
  return toolGroupKey(toolCallId, occurrence);
}

/**
 * The transcript stores `toolCall` and `toolResult` as separate parts,
 * sometimes interleaved across multiple message rows in one turn. We:
 *   1. Pair calls with their later results by tool_call_id so each tool
 *      renders as one logical entry (spinner → check).
 *   2. Group runs of contiguous tool entries (no assistant_text or
 *      user_message between them) into a single collapsible "tool_group".
 *      Mirrors Claude.ai's pattern — one card per cluster, summary shows
 *      the most recent tool name, expand to see all of them.
 */
export function collapseEvents(events: TranscriptEvent[]): RenderedItem[] {
  type Step =
    | { tag: "tool"; entry: ToolEntry }
    | { tag: "msg"; item: RenderedItem };
  const steps: Step[] = [];
  const callIndex = new Map<string, number>();
  const closeOpenTools = (ok: boolean) => {
    for (const idx of callIndex.values()) {
      const step = steps[idx];
      if (step?.tag === "tool" && !step.entry.done) {
        step.entry = { ...step.entry, done: true, ok };
      }
    }
    callIndex.clear();
  };
  for (const e of events) {
    if (e.kind === "tool_call") {
      callIndex.set(e.tool_call_id, steps.length);
      steps.push({
        tag: "tool",
        entry: {
          toolCallId: e.tool_call_id,
          name: e.name,
          label: e.label,
          result: null,
          ok: true,
          done: false,
        },
      });
      continue;
    }
    if (e.kind === "tool_result") {
      const idx = callIndex.get(e.tool_call_id);
      const step = idx != null ? steps[idx] : null;
      if (step && step.tag === "tool") {
        step.entry = {
          ...step.entry,
          result: e.summary,
          ok: e.ok,
          done: true,
        };
        callIndex.delete(e.tool_call_id);
        continue;
      }
      steps.push({
        tag: "tool",
        entry: {
          toolCallId: e.tool_call_id,
          name: e.name,
          label: null,
          result: e.summary,
          ok: e.ok,
          done: true,
        },
      });
      continue;
    }
    if (e.kind === "user_message") {
      // A new user turn is a hard boundary. If the previous harness turn
      // vanished before emitting a tool result, keep that historical row
      // static and failed instead of animating it forever or pairing a
      // later turn's reused tool id with it.
      closeOpenTools(false);
      steps.push({
        tag: "msg",
        item: { kind: "user_message", key: e.id, body: e.body, system: e.system },
      });
      continue;
    }
    if (e.kind === "assistant_text") {
      steps.push({
        tag: "msg",
        item: { kind: "assistant_text", key: e.id, body: e.body },
      });
      continue;
    }
    if (e.kind === "lifecycle") {
      if (e.phase === "done") {
        // A final/error event is surfaced as lifecycle "done" by
        // transcript-tail. The turn is terminal even if a harness omitted
        // one tool-result event, so no tool from it may remain "live".
        closeOpenTools(e.ok !== false);
      } else if (e.phase === "start") {
        closeOpenTools(false);
      }
      continue;
    }
    if (e.kind === "unknown") {
      steps.push({
        tag: "msg",
        item: { kind: "system_unknown", key: e.id, raw_type: e.raw_type },
      });
      continue;
    }
  }
  const out: RenderedItem[] = [];
  let buffer: ToolEntry[] = [];
  const groupOccurrences = new Map<string, number>();
  const flush = () => {
    if (buffer.length === 0) return;
    const firstToolCallId = buffer[0]!.toolCallId;
    const occurrence = groupOccurrences.get(firstToolCallId) ?? 0;
    out.push({
      kind: "tool_group",
      key: toolGroupKey(firstToolCallId, occurrence),
      tools: buffer,
    });
    groupOccurrences.set(firstToolCallId, occurrence + 1);
    buffer = [];
  };
  for (const step of steps) {
    if (step.tag === "tool") {
      buffer.push(step.entry);
    } else {
      flush();
      out.push(step.item);
    }
  }
  flush();
  return out;
}

// ── SSE plumbing for the active send ────────────────────────────────────

export type SseToolEvent = {
  phase: "start" | "update" | "result";
  tool_call_id: string;
  name: string;
  label?: string;
};

export type SsePerfMark = { name: string; at: number; delta: number };
export type SseMeta = {
  message_chars?: number;
  is_kickoff?: boolean;
  agent?: string;
  session_id?: string;
};

export function handleSseEvent(
  raw: string,
  handlers: {
    onText: (chunk: string) => void;
    onTool: (evt: SseToolEvent) => void;
    onError: (msg: string) => void;
    onLifecycle?: (phase: string) => void;
    onMeta?: (meta: SseMeta) => void;
    onPerf?: (marks: SsePerfMark[]) => void;
  },
) {
  const lines = raw.split("\n");
  const evtLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  if (!evtLine || !dataLine) return;
  const evt = evtLine.slice("event: ".length);
  let data: unknown;
  try {
    data = JSON.parse(dataLine.slice("data: ".length));
  } catch {
    return;
  }
  if (evt === "text") {
    const chunk = (data as { chunk?: string }).chunk;
    if (typeof chunk === "string") handlers.onText(chunk);
    return;
  }
  if (evt === "tool") {
    handlers.onTool(data as SseToolEvent);
    return;
  }
  if (evt === "lifecycle") {
    const phase = (data as { phase?: string }).phase;
    if (typeof phase === "string" && handlers.onLifecycle) {
      handlers.onLifecycle(phase);
    }
    return;
  }
  if (evt === "meta") {
    if (handlers.onMeta) handlers.onMeta(data as SseMeta);
    return;
  }
  if (evt === "perf") {
    const marks = (data as { marks?: SsePerfMark[] }).marks;
    if (Array.isArray(marks) && handlers.onPerf) handlers.onPerf(marks);
    return;
  }
  if (evt === "error") {
    const msg = (data as { message?: string }).message ?? "unknown error";
    handlers.onError(msg);
    return;
  }
}

export function upsertToolEntry(
  prev: ToolEntry[],
  evt: SseToolEvent,
): ToolEntry[] {
  const idx = prev.findIndex((t) => t.toolCallId === evt.tool_call_id);
  if (idx < 0) {
    return [
      ...prev,
      {
        toolCallId: evt.tool_call_id,
        name: evt.name,
        label: evt.label ?? null,
        result: null,
        ok: true,
        done: evt.phase === "result",
      },
    ];
  }
  const next = prev.slice();
  const existing = next[idx]!;
  next[idx] = {
    ...existing,
    name: evt.name,
    label: evt.label ?? existing.label,
    done: evt.phase === "result" ? true : existing.done,
  };
  return next;
}

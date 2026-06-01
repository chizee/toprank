import type { HarnessEvent } from "../types";

/**
 * Codex CLI emits one JSON event per line on stdout when invoked with
 * `codex exec --json ...`. Event shape (per the OpenAI codex docs):
 *
 *   { type: "thread.started", thread_id: "..." }
 *   { type: "item.started",   item: { type: "agent_message" | "tool_call", ... } }
 *   { type: "item.completed", item: { type: "agent_message", text: "..." } }
 *   { type: "turn.completed", usage: { ... } }
 *   { type: "turn.failed",    error: { message: "..." } }
 *   { type: "error",          message: "..." }
 *
 * Codex does NOT emit token-by-token deltas — agent_message text arrives
 * whole on item.completed. We forward it as one delta + a final at
 * turn.completed so the UI flow matches Claude Code's event sequence.
 */
export interface CodexStreamState {
  emittedTextLen: number;
  assistantText: string;
  finalized: boolean;
  threadId: string | null;
}

export function makeCodexStreamState(): CodexStreamState {
  return { emittedTextLen: 0, assistantText: "", finalized: false, threadId: null };
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: {
    type?: string;
    text?: string;
    name?: string;
    id?: string;
    command?: string;
    arguments?: Record<string, unknown>;
  };
  error?: { message?: string };
}

export function parseCodexLine(
  line: string,
  state: CodexStreamState,
): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: CodexEvent;
  try {
    event = JSON.parse(trimmed) as CodexEvent;
  } catch {
    return [];
  }

  const events: HarnessEvent[] = [];

  if (event.type === "thread.started") {
    state.threadId = event.thread_id ?? state.threadId;
    events.push({ kind: "lifecycle", phase: "start" });
    if (state.threadId) {
      events.push({ kind: "session", harnessSessionId: state.threadId });
    }
    return events;
  }

  if (event.type === "item.started" && event.item) {
    const item = event.item;
    if (item.type === "command_execution" || item.type === "tool_call") {
      const rawName = item.name ?? item.command ?? "tool";
      // Keep name single-line; multi-line commands belong in the label.
      const toolName = rawName.split("\n")[0];
      events.push({
        kind: "tool",
        phase: "start",
        toolCallId: item.id ?? "",
        name: toolName,
        label: labelForCodexInput(toolName, item),
      });
    }
    return events;
  }

  if (event.type === "item.completed" && event.item) {
    const item = event.item;
    if (item.type === "agent_message" && typeof item.text === "string") {
      state.assistantText += item.text;
      if (state.assistantText.length > state.emittedTextLen) {
        const delta = state.assistantText.slice(state.emittedTextLen);
        state.emittedTextLen = state.assistantText.length;
        events.push({ kind: "delta", text: delta });
      }
    } else if (item.type === "command_execution" || item.type === "tool_call") {
      events.push({
        kind: "tool",
        phase: "result",
        toolCallId: item.id ?? "",
        name: item.name ?? item.command ?? "tool",
      });
    }
    return events;
  }

  if (event.type === "turn.completed") {
    state.finalized = true;
    events.push({ kind: "final", text: state.assistantText });
    return events;
  }

  if (event.type === "turn.failed") {
    state.finalized = true;
    events.push({
      kind: "error",
      message: event.error?.message ?? "codex turn failed",
    });
    return events;
  }

  if (event.type === "error") {
    events.push({ kind: "error", message: event.message ?? "codex error" });
    return events;
  }

  return events;
}

function labelForCodexInput(
  name: string,
  item: { command?: string; arguments?: Record<string, unknown> },
): string | undefined {
  if (item.command && item.command.trim().length > 0) {
    const firstLine = item.command.split("\n")[0];
    return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
  }
  if (!item.arguments) return undefined;
  const tryKey = (k: string): string | null => {
    const v = item.arguments?.[k];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };
  return (
    tryKey("file_path") ??
    tryKey("path") ??
    tryKey("url") ??
    tryKey("query") ??
    undefined
  );
}

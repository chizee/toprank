import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSessionBySessionId } from "@/server/openclaw/sessions";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");

export type TranscriptEvent =
  | { kind: "user_message"; id: string; ts: number; body: string }
  | {
      kind: "assistant_text";
      id: string;
      ts: number;
      body: string;
    }
  | {
      kind: "tool_call";
      id: string;
      ts: number;
      tool_call_id: string;
      name: string;
      label: string | null;
    }
  | {
      kind: "tool_result";
      id: string;
      ts: number;
      tool_call_id: string;
      name: string;
      summary: string | null;
      ok: boolean;
    }
  | { kind: "unknown"; id: string; ts: number; raw_type: string };

type RawMessageContentPart =
  | { type: "text"; text?: string }
  | {
      type: "toolCall";
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      input?: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      toolCallId?: string;
      tool_call_id?: string;
      name?: string;
      content?: unknown;
      output?: unknown;
      isError?: boolean;
      is_error?: boolean;
    }
  | string;

type RawMessage = {
  role?: string;
  content?: string | RawMessageContentPart[];
  timestamp?: number;
  // Present on top-level toolResult messages (role: "toolResult"). OpenClaw
  // doesn't nest these inside the assistant turn's content array — they're
  // sibling entries with their own role.
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export type RawEntry = {
  type?: string;
  id?: string;
  timestamp?: string | number;
  message?: RawMessage;
};

function sessionJsonlPath(agentFullId: string, sessionId: string): string {
  return join(
    OPENCLAW_HOME,
    "agents",
    agentFullId,
    "sessions",
    `${sessionId}.jsonl`,
  );
}

/** Resolve URL threadId (label) → on-disk transcript file path. */
export function resolveTranscriptPath(
  agentFullId: string,
  threadId: string,
): string | null {
  const session = findSessionBySessionId(agentFullId, threadId);
  if (!session) return null;
  const path = sessionJsonlPath(agentFullId, session.sessionId);
  if (!existsSync(path)) return null;
  return path;
}

/**
 * Read the JSONL transcript from `byteOffset` to EOF, parse new lines into
 * structured events the client can render. Returns the new byte offset so the
 * caller can stitch incremental polls together without re-reading prior bytes.
 *
 * Returns `{ events: [], byteOffset, fileSize }` when the file doesn't exist
 * yet or no new bytes are available — caller treats it as a no-op.
 */
export function readTranscriptTail(
  agentFullId: string,
  threadId: string,
  byteOffset: number,
): { events: TranscriptEvent[]; byteOffset: number; fileSize: number } {
  const path = resolveTranscriptPath(agentFullId, threadId);
  if (!path) return { events: [], byteOffset, fileSize: 0 };

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], byteOffset, fileSize: 0 };
  }

  // Defensive: if the file got truncated/rotated, reset to 0.
  if (byteOffset > size) byteOffset = 0;
  if (byteOffset === size) return { events: [], byteOffset, fileSize: size };

  let raw: string;
  try {
    const buf = readFileSync(path);
    raw = buf.slice(byteOffset).toString("utf8");
  } catch {
    return { events: [], byteOffset, fileSize: size };
  }

  // Only consume up to the last newline; whatever's after is a partial line
  // the writer is still flushing. Leave its bytes unconsumed by reporting an
  // offset that points right after the last complete line.
  const lastNl = raw.lastIndexOf("\n");
  const consumable = lastNl < 0 ? "" : raw.slice(0, lastNl + 1);
  const newByteOffset = byteOffset + Buffer.byteLength(consumable, "utf8");

  const events: TranscriptEvent[] = [];
  let lineIdx = 0;
  for (const line of consumable.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue;
    }
    events.push(...rawEntryToEvents(entry, `${entry.id ?? "anon"}-${lineIdx++}`));
  }

  return { events, byteOffset: newByteOffset, fileSize: size };
}

/**
 * Convert one raw JSONL entry (or session.message broadcast payload) into
 * the TranscriptEvents we render. Extracted so the SSE re-attach bridge
 * (which receives `session.message` events from the gateway) can produce
 * the same shapes the polling path already emits.
 */
export function rawEntryToEvents(entry: RawEntry, baseId: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const ts =
    typeof entry.timestamp === "string"
      ? Date.parse(entry.timestamp)
      : typeof entry.timestamp === "number"
        ? entry.timestamp
        : 0;

  if (entry.type !== "message") {
    events.push({ kind: "unknown", id: baseId, ts, raw_type: entry.type ?? "?" });
    return events;
  }
  const msg = entry.message;
  if (!msg) return events;

  if (msg.role === "user") {
    const body = extractUserText(msg.content);
    if (!body) return events;
    events.push({ kind: "user_message", id: baseId, ts, body });
    return events;
  }
  if (msg.role === "toolResult") {
    const callId = msg.toolCallId ?? "";
    const name = msg.toolName ?? "tool";
    const ok = !msg.isError;
    const summary = summarizeToolResult(msg.content);
    if (callId) {
      events.push({
        kind: "tool_result",
        id: baseId,
        ts,
        tool_call_id: callId,
        name,
        summary,
        ok,
      });
    }
    return events;
  }
  if (msg.role !== "assistant") return events;

  const parts = Array.isArray(msg.content) ? msg.content : [];
  let partIdx = 0;
  for (const part of parts) {
    const partId = `${baseId}:${partIdx++}`;
    if (typeof part === "string") {
      if (part.trim()) {
        events.push({ kind: "assistant_text", id: partId, ts, body: part });
      }
      continue;
    }
    if (part?.type === "text") {
      const text = (part.text ?? "").trim();
      if (text) {
        events.push({ kind: "assistant_text", id: partId, ts, body: text });
      }
      continue;
    }
    if (part?.type === "toolCall") {
      const callId = part.id ?? partId;
      const name = part.name ?? "tool";
      const label = formatToolLabel(name, part.arguments ?? part.input);
      events.push({
        kind: "tool_call",
        id: partId,
        ts,
        tool_call_id: callId,
        name,
        label,
      });
      continue;
    }
    if (part?.type === "toolResult") {
      const callId = part.toolCallId ?? part.tool_call_id ?? partId;
      const name = part.name ?? "tool";
      const ok = !(part.isError ?? part.is_error ?? false);
      const summary = summarizeToolResult(part.content ?? part.output);
      events.push({
        kind: "tool_result",
        id: partId,
        ts,
        tool_call_id: callId,
        name,
        summary,
        ok,
      });
      continue;
    }
  }
  return events;
}

function extractUserText(content: RawMessage["content"]): string {
  if (typeof content === "string") return stripUserTimestampPrefix(content);
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) {
    if (typeof c === "string") out.push(c);
    else if (c?.type === "text" && typeof c.text === "string") out.push(c.text);
  }
  return stripUserTimestampPrefix(out.join("\n").trim());
}

function stripUserTimestampPrefix(s: string): string {
  return s.replace(
    /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,5}\] ?/,
    "",
  );
}

function formatToolLabel(
  name: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  // Pick the most informative single field from common tool shapes.
  if (typeof args.command === "string") return shortenLine(args.command);
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.url === "string") return args.url;
  if (typeof args.query === "string") return shortenLine(args.query);
  if (typeof args.pattern === "string") return args.pattern;
  // MCP tools tend to use namespaced names; fall back to a JSON preview.
  try {
    return shortenLine(JSON.stringify(args));
  } catch {
    return null;
  }
}

function summarizeToolResult(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return shortenLine(content);
  if (Array.isArray(content)) {
    const text = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (!c || typeof c !== "object") return "";
        const obj = c as { text?: unknown; content?: unknown };
        // Prefer `text`, fall back to `content` (some MCPs put the payload
        // under `content` directly without splitting into a text/data union).
        if (typeof obj.text === "string" && obj.text) return obj.text;
        if (typeof obj.content === "string" && obj.content) return obj.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text ? shortenLine(text) : null;
  }
  if (typeof content === "object") {
    try {
      return shortenLine(JSON.stringify(content));
    } catch {
      return null;
    }
  }
  return null;
}

function shortenLine(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

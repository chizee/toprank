import { mkdir, appendFile, stat, readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ChatStreamEvent } from "@/server/openclaw/gateway-client";

/**
 * Per-thread shadow transcript that runTaskKickoffServerSide writes as
 * gateway-stream events arrive. Exists because OpenClaw's codex-app-server
 * backend buffers the agent's whole turn in memory and writes the
 * session.jsonl in one shot at session-end via mirrorTranscriptBestEffort
 * — which means `sessions.messages.subscribe` over the WS gateway never
 * fires `session.message` events DURING a turn, even though the agent is
 * producing tokens. Our shadow log fills that gap: we append OpenClaw-
 * shaped lines as soon as we see each delta / tool call / tool result,
 * the SSE bridge tails this file with fs.watch, and the browser renders
 * tokens live just like /api/chat already does.
 *
 * The format is intentionally a subset of OpenClaw's session.jsonl
 * schema so readTranscriptTail's existing parser (rawEntryToEvents)
 * works on both files. The same TranscriptEvent.id space means the
 * client's seenEventIdsRef dedups when OpenClaw eventually flushes its
 * own copy of the transcript at session-end.
 *
 * Location: `~/.notfair-cmo/agents/<agentFullId>/shadow/<threadId>.jsonl`.
 * Living under .notfair-cmo (not .openclaw) so OpenClaw's writers can't
 * race ours; readTranscriptTail explicitly merges both files.
 */

function dataDir(): string {
  return process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
}

export function shadowTranscriptPath(
  agentFullId: string,
  threadId: string,
): string {
  return join(dataDir(), "agents", agentFullId, "shadow", `${threadId}.jsonl`);
}

export function shadowTranscriptExists(
  agentFullId: string,
  threadId: string,
): boolean {
  return existsSync(shadowTranscriptPath(agentFullId, threadId));
}

export async function ensureShadowDir(
  agentFullId: string,
  threadId: string,
): Promise<void> {
  await mkdir(dirname(shadowTranscriptPath(agentFullId, threadId)), {
    recursive: true,
  });
}

/**
 * State machine the gateway-stream consumer keeps per turn. Deltas
 * accumulate into a single assistant text event committed when the
 * stream emits `final` (or the turn ends). Tool starts/results write
 * dedicated entries with the gateway's toolCallId so the client can
 * pair them.
 */
export type ShadowWriter = {
  /** Append `assistantBuffer` as a single assistant message + clear. */
  flushAssistant(): Promise<void>;
  /** Push another delta of token text onto the assistant buffer. */
  appendDelta(text: string): void;
  /**
   * Replace the assistant buffer with `text`. Used on the gateway's
   * `final` event — for providers that emit BOTH per-token deltas and
   * a cumulative final, appending would double-count. Replace makes the
   * final authoritative.
   */
  replaceAssistant(text: string): void;
  /** Record a tool call start. */
  toolStart(toolCallId: string, name: string, label?: string): Promise<void>;
  /** Record a tool result (success or error). */
  toolResult(
    toolCallId: string,
    name: string,
    ok: boolean,
    summary?: string,
  ): Promise<void>;
  /** Close the writer — flushes any pending assistant text. */
  close(): Promise<void>;
};

export async function openShadowWriter(
  agentFullId: string,
  threadId: string,
): Promise<ShadowWriter> {
  await ensureShadowDir(agentFullId, threadId);
  const path = shadowTranscriptPath(agentFullId, threadId);
  let assistantBuffer = "";

  async function writeEntry(entry: object): Promise<void> {
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async function flushAssistant(): Promise<void> {
    const body = assistantBuffer.trim();
    assistantBuffer = "";
    if (!body) return;
    await writeEntry({
      type: "message",
      id: `shadow-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: body }],
      },
    });
  }

  return {
    appendDelta(text: string) {
      assistantBuffer += text;
    },
    replaceAssistant(text: string) {
      assistantBuffer = text;
    },
    flushAssistant,
    async toolStart(toolCallId, name, label) {
      // Flush any preceding assistant text so the tool call shows in the
      // right order in the transcript.
      await flushAssistant();
      await writeEntry({
        type: "message",
        id: `shadow-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: toolCallId,
              name,
              ...(label ? { arguments: { __label: label } } : {}),
            },
          ],
        },
      });
    },
    async toolResult(toolCallId, name, ok, summary) {
      await writeEntry({
        type: "message",
        id: `shadow-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId,
          toolName: name,
          isError: !ok,
          content: summary
            ? [{ type: "text", text: summary }]
            : undefined,
        },
      });
    },
    async close() {
      await flushAssistant();
    },
  };
}

/**
 * Hook into runTaskKickoffServerSide's stream: forward each event to
 * the shadow writer with reasonable bucketing. Returns a function that
 * closes the writer (flush any buffered assistant text).
 */
export async function shadowStreamEvent(
  writer: ShadowWriter,
  evt: ChatStreamEvent,
): Promise<void> {
  switch (evt.kind) {
    case "delta":
      writer.appendDelta(evt.text);
      return;
    case "final":
      // `final.text` is the cumulative assistant turn — for providers
      // that ALSO emit per-token deltas, naive appending would
      // double-count the same text. Replace the buffer with `final`
      // and flush exactly once. Providers that only emit final
      // (deltaless backends) land in the same place.
      writer.replaceAssistant(evt.text);
      await writer.flushAssistant();
      return;
    case "tool":
      if (evt.phase === "start") {
        await writer.toolStart(evt.toolCallId, evt.name, evt.label);
      } else if (evt.phase === "result") {
        // We don't know ok/summary from the result event shape; treat
        // as ok with no summary. Errors will surface via the gateway's
        // own `error` events.
        await writer.toolResult(evt.toolCallId, evt.name, true, evt.label);
      }
      return;
    case "lifecycle":
    case "error":
      return;
  }
}

/**
 * Read the shadow JSONL from `byteOffset` to EOF. Mirrors the API of
 * readTranscriptTail so the polling path can merge shadow + OpenClaw
 * transcripts.
 */
export type ShadowTailResult = {
  bytes: string;
  byteOffset: number;
  fileSize: number;
};

export function readShadowTail(
  agentFullId: string,
  threadId: string,
  byteOffset: number,
): ShadowTailResult {
  const path = shadowTranscriptPath(agentFullId, threadId);
  if (!existsSync(path)) return { bytes: "", byteOffset, fileSize: 0 };
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { bytes: "", byteOffset, fileSize: 0 };
  }
  if (byteOffset > size) byteOffset = 0;
  if (byteOffset === size) return { bytes: "", byteOffset, fileSize: size };
  let raw: string;
  try {
    const buf = readFileSync(path);
    raw = buf.slice(byteOffset).toString("utf8");
  } catch {
    return { bytes: "", byteOffset, fileSize: size };
  }
  const lastNl = raw.lastIndexOf("\n");
  const consumable = lastNl < 0 ? "" : raw.slice(0, lastNl + 1);
  const newByteOffset = byteOffset + Buffer.byteLength(consumable, "utf8");
  return { bytes: consumable, byteOffset: newByteOffset, fileSize: size };
}

/** Async read for SSE tailer that wants non-blocking IO. */
export async function readShadowFromOffset(
  agentFullId: string,
  threadId: string,
  byteOffset: number,
): Promise<ShadowTailResult> {
  const path = shadowTranscriptPath(agentFullId, threadId);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { bytes: "", byteOffset, fileSize: 0 };
  }
  if (byteOffset > size) byteOffset = 0;
  if (byteOffset === size) return { bytes: "", byteOffset, fileSize: size };
  let raw: string;
  try {
    const buf = await readFile(path);
    raw = buf.slice(byteOffset).toString("utf8");
  } catch {
    return { bytes: "", byteOffset, fileSize: size };
  }
  const lastNl = raw.lastIndexOf("\n");
  const consumable = lastNl < 0 ? "" : raw.slice(0, lastNl + 1);
  const newByteOffset = byteOffset + Buffer.byteLength(consumable, "utf8");
  return { bytes: consumable, byteOffset: newByteOffset, fileSize: size };
}

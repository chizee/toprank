import { watch } from "node:fs";
import { NextResponse } from "next/server";

import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { getProject } from "@/server/db/projects";
import { rawEntryToEvents } from "@/server/openclaw/transcript-tail";
import {
  readShadowFromOffset,
  shadowTranscriptPath,
} from "@/server/openclaw/shadow-transcript";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEBUG = process.env.NOTFAIR_LIVE_BRIDGE_DEBUG !== "0";
function log(...args: unknown[]): void {
  if (DEBUG) console.log("[live-bridge]", ...args);
}

/**
 * SSE bridge that streams a task's transcript live. Tails the shadow
 * JSONL that runTaskKickoffServerSide writes as the gateway stream
 * yields events; that file mirrors OpenClaw's session.jsonl schema so
 * the parser is the same one polling uses.
 *
 * Why not OpenClaw's WS-side `sessions.messages.subscribe`: that fires
 * `session.message` events only when transcript-mirror appends a
 * message, and the codex-app-server backend defers appending to
 * session-end via mirrorTranscriptBestEffort. The result: zero events
 * mid-turn. The shadow log fills that gap server-side.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ agent: string; thread: string }> },
): Promise<Response> {
  const { agent: agentSlug, thread: threadId } = await params;
  log("GET", { agentSlug, threadId });

  const url = new URL(request.url);
  const projectSlug = url.searchParams.get("project");
  const projectRow = projectSlug ? getProject(projectSlug) : await getActiveProject();
  if (!projectRow || projectRow.archived_at) {
    log("project not found", { projectSlug });
    return NextResponse.json({ error: "Unknown project" }, { status: 404 });
  }
  const resolved = await resolveAgentBySlug(projectRow.slug, agentSlug);
  if (!resolved) {
    log("agent not found", { projectSlug: projectRow.slug, agentSlug });
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }
  const agentFullId = resolved.agent_id;
  const path = shadowTranscriptPath(agentFullId, threadId);
  log("ready to tail", { agentFullId, threadId, path });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let byteOffset = 0;
      let watcher: ReturnType<typeof watch> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let pumping = false;
      let forwardedCount = 0;

      function send(event: string, data: unknown): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // stream torn down
        }
      }

      function teardown(): void {
        if (closed) return;
        closed = true;
        log("teardown", { forwarded: forwardedCount, byteOffset });
        try {
          watcher?.close();
        } catch {}
        if (pollTimer) clearInterval(pollTimer);
        try {
          controller.close();
        } catch {}
      }

      request.signal.addEventListener("abort", teardown);

      async function pump(): Promise<void> {
        if (closed) return;
        if (pumping) return;
        pumping = true;
        try {
          const { bytes, byteOffset: nextOffset } = await readShadowFromOffset(
            agentFullId,
            threadId,
            byteOffset,
          );
          if (bytes.length === 0) return;
          byteOffset = nextOffset;
          const lines = bytes.split("\n").filter((l) => l.trim().length > 0);
          let lineIdx = forwardedCount;
          const events = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as Parameters<
                typeof rawEntryToEvents
              >[0];
              const baseId = `${entry.id ?? "shadow"}-${lineIdx++}`;
              events.push(...rawEntryToEvents(entry, baseId));
            } catch {
              // skip malformed
            }
          }
          if (events.length > 0) {
            forwardedCount += events.length;
            log("forwarded", { count: events.length, total: forwardedCount });
            send("transcript", { events });
          }
        } catch (err) {
          log("pump error", err);
        } finally {
          pumping = false;
        }
      }

      try {
        send("ready", { path });
        // Initial pump in case the file already has content.
        await pump();
        // fs.watch fires inotify/FSEvents on append. The kernel notification
        // can lag a few ms; we also poll every 500ms as a safety net so a
        // missed inotify event (notoriously flaky on some filesystems)
        // doesn't strand the user.
        try {
          watcher = watch(path, { persistent: true }, () => {
            void pump();
          });
        } catch {
          // File doesn't exist yet — runTaskKickoffServerSide will create
          // it once the task is kicked off. Rely on poll fallback.
          log("watch failed, polling only");
        }
        pollTimer = setInterval(() => {
          void pump();
        }, 500);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("error", { message });
        send("error", { message });
        teardown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

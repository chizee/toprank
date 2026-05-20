import { NextResponse } from "next/server";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { streamChatViaGateway } from "@/server/openclaw/gateway-client";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
} from "@/server/openclaw/sessions";
import { processOrchestrationBlocks } from "@/server/orchestration/process-blocks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight per-request profiler. Records ms-offsets from request start so
 * we can attribute end-to-end latency to a stage (route boot, gateway open,
 * model first-token, etc.). Marks are emitted to stdout and to the client as
 * an SSE `perf` event so they show up in both the dev terminal and the browser
 * console. Toggle off with `NOTFAIR_CHAT_PERF=0`.
 */
const PERF_ON = process.env.NOTFAIR_CHAT_PERF !== "0";

function makePerf(tag: string) {
  const start = performance.now();
  const marks: Array<{ name: string; at: number; delta: number }> = [];
  let last = start;
  const mark = (name: string) => {
    if (!PERF_ON) return;
    const now = performance.now();
    const at = now - start;
    const delta = now - last;
    last = now;
    marks.push({ name, at, delta });
    // eslint-disable-next-line no-console
    console.log(
      `[chat-perf ${tag}] +${at.toFixed(1)}ms (Δ${delta.toFixed(1)}ms) ${name}`,
    );
  };
  const summary = () => marks;
  return { mark, summary };
}

type ChatPostBody = {
  message: string;
  agent?: string;
  /** OpenClaw session UUID — used for trajectory file naming. */
  sessionId?: string;
  /**
   * OpenClaw's canonical `agent:<agent>:<label>` key for this thread. When the
   * client knows the right key (e.g., `agent:foo:main` for an existing thread
   * whose label is not the sessionId), pass it here. Falls back to a
   * sessionId-derived key for brand-new threads.
   */
  sessionKey?: string;
};

export async function POST(request: Request) {
  const perf = makePerf("route");
  perf.mark("route_start");
  const project = await getActiveProject();
  perf.mark("active_project_resolved");
  if (!project) {
    return NextResponse.json(
      { error: "No active project. Create one first." },
      { status: 400 },
    );
  }

  let body: ChatPostBody;
  try {
    body = (await request.json()) as ChatPostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  perf.mark("body_parsed");
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const requestedSlug = (body.agent ?? "cmo").trim();
  const resolved = await resolveAgentBySlug(project.slug, requestedSlug);
  perf.mark("agent_resolved");
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown agent: '${requestedSlug}'` },
      { status: 404 },
    );
  }

  const agentName = resolved.agent_id;

  // Resolve session: explicit body wins. New pages always pass both sessionId
  // and sessionKey; sessionKey-only callers (legacy or external) get the
  // canonical key looked up below.
  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId is required (call from a threaded chat URL)." },
      { status: 400 },
    );
  }
  let sessionKey = body.sessionKey?.trim();
  if (!sessionKey) {
    const known = findSessionBySessionId(agentName, sessionId);
    sessionKey = known?.sessionKey ?? buildPendingSessionKey(agentName, sessionId);
  }
  perf.mark("session_resolved");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Track whether the SSE client is still connected. Once they navigate
      // away or close the tab, controller.enqueue throws — we flip this flag
      // and silently drop further sends. The agent run on OpenClaw keeps
      // going, the assistantBuffer keeps accumulating, and orchestration
      // still runs at the end. Persistence (JSONL) happens server-side
      // regardless, so when the user returns, the transcript-tail endpoint
      // surfaces the full response on the next poll.
      let clientOpen = true;
      const send = (event: string, data: unknown) => {
        if (!clientOpen) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          clientOpen = false;
        }
      };

      // Deliberately do NOT propagate request.signal to the gateway abort
      // signal. The user expectation: "if I switch agents or close the tab,
      // the agent should keep responding; when I switch back, show the
      // result." Honoring disconnect-as-cancel kills mid-flight agent runs
      // and breaks that promise. The Stop button is now a future-TODO
      // (separate POST /api/chat/stop endpoint) — there isn't a way to
      // explicitly cancel a run today, only the implicit disconnect path
      // which we no longer treat as cancel.
      const noAbort = new AbortController(); // never aborted; just satisfies the signal param

      let firstSseDeltaSent = false;
      let assistantBuffer = "";
      try {
        perf.mark("stream_start");
        send("meta", {
          project_slug: project.slug,
          agent: agentName,
          session_id: sessionId,
          session_key: sessionKey,
        });
        for await (const evt of streamChatViaGateway({
          sessionKey,
          sessionId,
          message: body.message,
          signal: noAbort.signal,
          perf,
        })) {
          if (evt.kind === "delta") {
            if (!firstSseDeltaSent) {
              firstSseDeltaSent = true;
              perf.mark("first_sse_delta_sent");
            }
            assistantBuffer += evt.text;
            send("text", { chunk: evt.text });
          } else if (evt.kind === "tool") {
            // tool start/update/result — keyed by toolCallId so the client
            // can update the matching step row instead of appending a new one.
            send("tool", {
              phase: evt.phase,
              tool_call_id: evt.toolCallId,
              name: evt.name,
              label: evt.label,
            });
          } else if (evt.kind === "lifecycle") {
            send("lifecycle", { phase: evt.phase });
          } else if (evt.kind === "error") {
            send("error", { message: evt.message });
          }
          // "final" implicitly ends the loop after; no separate signal needed.
        }
        perf.mark("stream_done");

        // Process orchestration blocks emitted by the agent during the turn.
        // Tasks created, status updates, comments, ask_user, approval requests
        // all materialize as DB rows here. Failures are non-fatal — the user
        // still sees the assistant reply; orchestration just doesn't apply.
        if (assistantBuffer.trim().length > 0) {
          try {
            const outcome = await processOrchestrationBlocks(assistantBuffer, {
              project_slug: project.slug,
              agent_id: agentName,
            });
            perf.mark("orchestration_done");
            if (
              outcome.tasks_created.length > 0 ||
              outcome.task_status_updates.length > 0 ||
              outcome.comments_added.length > 0 ||
              outcome.ask_user.length > 0 ||
              outcome.approvals_requested.length > 0 ||
              outcome.errors.length > 0
            ) {
              send("orchestration", {
                tasks_created: outcome.tasks_created.map((t) => ({
                  id: t.id,
                  title: t.title,
                  assignee: t.agent_id,
                  status: t.status,
                })),
                task_status_updates: outcome.task_status_updates,
                comments_added: outcome.comments_added,
                ask_user: outcome.ask_user,
                approvals_requested: outcome.approvals_requested,
                errors: outcome.errors,
              });
            }
          } catch (orchErr) {
            // Don't let an orchestration parse failure break the chat reply.
            console.error("[chat] orchestration processing failed:", orchErr);
          }
        }

        send("perf", { marks: perf.summary() });
        send("done", {});
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Controller may already be closed if the client disconnected
          // mid-stream — silent because the agent run continued + persisted.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

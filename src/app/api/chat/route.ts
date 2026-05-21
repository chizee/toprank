import { NextResponse } from "next/server";
import { getActiveProject } from "@/server/active-project";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { streamChatViaGateway } from "@/server/openclaw/gateway-client";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
} from "@/server/openclaw/sessions";
import { claimProposedTask, getTask } from "@/server/db/tasks";

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
  /**
   * URL slug of the project this chat belongs to. The page passes it down so
   * the route doesn't have to rely on the active-project cookie, which can
   * lag the URL on first paint after a project switch or direct deep-link.
   */
  project?: string;
  /** OpenClaw session UUID — used for trajectory file naming. */
  sessionId?: string;
  /**
   * OpenClaw's canonical `agent:<agent>:<label>` key for this thread. When the
   * client knows the right key (e.g., `agent:foo:main` for an existing thread
   * whose label is not the sessionId), pass it here. Falls back to a
   * sessionId-derived key for brand-new threads.
   */
  sessionKey?: string;
  /**
   * When set, this turn is a task kickoff: atomically claim the task
   * (proposed → working) before forwarding to the gateway. The claim is
   * conditional on status='proposed', so concurrent kickoffs or reloads
   * mid-run are rejected with 409 instead of double-firing the agent.
   * Absent for normal user-typed messages.
   */
  task_id?: string;
};

export async function POST(request: Request) {
  const perf = makePerf("route");
  perf.mark("route_start");

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

  // Explicit project (from the URL slug the page knows) wins; fall back to
  // the cookie for backwards compatibility with any non-page caller.
  const project = body.project
    ? getProject(body.project)
    : await getActiveProject();
  perf.mark("active_project_resolved");
  if (!project) {
    return NextResponse.json(
      { error: "No active project. Create one first." },
      { status: 400 },
    );
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

  // Task-kickoff path: claim the proposed task before streaming so a single
  // turn can't fire twice (page reload / two tabs / StrictMode double-mount).
  // claimProposedTask is a conditional UPDATE keyed on status='proposed';
  // any other state (working/done/failed/cancelled) returns null and we
  // reject with 409. Callers (LiveTranscript auto-kickoff) treat 409 as a
  // benign no-op — the task is already running or finished elsewhere.
  const taskId = body.task_id?.trim();
  if (taskId) {
    const existing = getTask(taskId);
    if (!existing) {
      return NextResponse.json(
        { error: `Unknown task_id '${taskId}'` },
        { status: 404 },
      );
    }
    if (existing.agent_id !== agentName) {
      return NextResponse.json(
        {
          error: `Task ${existing.display_id} belongs to ${existing.agent_id}, not ${agentName}`,
        },
        { status: 400 },
      );
    }
    const claimed = claimProposedTask(existing.id);
    if (!claimed) {
      return NextResponse.json(
        {
          error: "task already claimed",
          status: existing.status,
          task_id: existing.id,
        },
        { status: 409 },
      );
    }
  }
  perf.mark("task_claim_resolved");

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
        // Surface input sizes so each perf trace tells us *why* this turn
        // was fast/slow — a 24KB system prompt with a 1.8KB kickoff brief
        // behaves very differently from a 200B reply. Browser console
        // table includes these alongside the timing marks.
        send("meta", {
          project_slug: project.slug,
          agent: agentName,
          session_id: sessionId,
          session_key: sessionKey,
          message_chars: body.message.length,
          is_kickoff: Boolean(taskId),
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

        // Orchestration side effects (task creation, status updates,
        // comments, approvals) now happen via the notfair-orchestration MCP
        // server — the agent calls those tools mid-stream and the handler
        // mutates DB rows directly. We no longer regex-scan the assistant
        // reply for pseudo-XML blocks. See agent-templates.ts for the
        // procedural teaching pattern.

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

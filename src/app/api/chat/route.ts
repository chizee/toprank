import { NextResponse } from "next/server";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { streamChatViaGateway } from "@/server/openclaw/gateway-client";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
} from "@/server/openclaw/sessions";

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
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const abortCtl = new AbortController();
      request.signal?.addEventListener("abort", () => abortCtl.abort(), { once: true });

      let firstSseDeltaSent = false;
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
          signal: abortCtl.signal,
          perf,
        })) {
          if (evt.kind === "delta") {
            if (!firstSseDeltaSent) {
              firstSseDeltaSent = true;
              perf.mark("first_sse_delta_sent");
            }
            send("text", { chunk: evt.text });
          } else if (evt.kind === "error") {
            send("error", { message: evt.message });
          }
          // "final" implicitly ends the loop after; no separate signal needed.
        }
        perf.mark("stream_done");
        send("perf", { marks: perf.summary() });
        send("done", {});
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
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

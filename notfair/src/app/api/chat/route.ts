import { NextResponse } from "next/server";
import { getActiveProject } from "@/server/active-project";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { requireAdapter } from "@/server/adapters/registry";
import { workspaceDirFor } from "@/server/agents/provisioning";
import {
  getOrCreateSession,
  appendTranscriptEvent,
  touchSession,
} from "@/server/sessions";
import {
  registerLiveTurn,
  releaseLiveTurn,
} from "@/server/sessions/live-turns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ChatPostBody = {
  message: string;
  agent?: string;
  /** URL slug of the project this chat belongs to. */
  project?: string;
  /**
   * Thread label — stable identifier for the chat thread. The route maps
   * (project, agent, label) → a sessions row; if none exists it's created.
   * Defaults to "main" when omitted.
   */
  thread?: string;
  /**
   * Per-turn model override from the composer's model selector. Must be
   * one of HARNESS_MODEL_OPTIONS for the project's adapter — anything
   * else is a 400 (values become CLI spawn args, so no passthrough).
   */
  model?: string;
  /** Provider-supported per-turn reasoning effort override. */
  reasoning_effort?: string;
};

export async function POST(request: Request) {
  let body: ChatPostBody;
  try {
    body = (await request.json()) as ChatPostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const project = body.project ? getProject(body.project) : await getActiveProject();
  if (!project) {
    return NextResponse.json(
      { error: "No active project. Create one first." },
      { status: 400 },
    );
  }

  const requestedSlug = (body.agent ?? "").trim();
  if (!requestedSlug) {
    return NextResponse.json({ error: "agent is required" }, { status: 400 });
  }
  const resolved = await resolveAgentBySlug(project.slug, requestedSlug);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown agent: '${requestedSlug}'` },
      { status: 404 },
    );
  }

  // Whitelist the model against the adapter's provider-fed list — the
  // value becomes a CLI spawn arg, so arbitrary client strings never
  // pass through unchecked.
  if (body.model !== undefined && typeof body.model !== "string") {
    return NextResponse.json({ error: "model must be a string" }, { status: 400 });
  }
  if (
    body.reasoning_effort !== undefined &&
    typeof body.reasoning_effort !== "string"
  ) {
    return NextResponse.json(
      { error: "reasoning_effort must be a string" },
      { status: 400 },
    );
  }
  const model = body.model?.trim() || null;
  const reasoningEffort = body.reasoning_effort?.trim() || null;
  if (model || reasoningEffort) {
    const available = await requireAdapter(project.harness_adapter).listModels();
    if (model && !available.some((m) => m.value === model)) {
      return NextResponse.json(
        { error: `Unknown model '${model}' for adapter '${project.harness_adapter}'` },
        { status: 400 },
      );
    }
    const selectedModel = model
      ? available.find((option) => option.value === model)
      : available.find((option) => option.is_default) ?? available[0];
    if (
      reasoningEffort &&
      !selectedModel?.reasoning_efforts?.some(
        (option) => option.value === reasoningEffort,
      )
    ) {
      return NextResponse.json(
        {
          error: `Unknown reasoning effort '${reasoningEffort}' for model '${selectedModel?.value ?? "default"}'`,
        },
        { status: 400 },
      );
    }
  }

  const label =
    body.thread?.trim() || "main";
  const session = getOrCreateSession({
    project_slug: project.slug,
    agent_id: resolved.agent_id,
    label,
    harness_adapter: project.harness_adapter,
  });
  appendTranscriptEvent(session.id, "user", { text: body.message });

  const adapter = requireAdapter(project.harness_adapter);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
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

      // Disconnect != cancel: the harness keeps running and persisting
      // events to the transcript; the user sees them on next attach. Only
      // the explicit stop endpoint (POST /api/chat/stop) aborts this
      // controller, which SIGTERMs the harness subprocess.
      const ctrl = registerLiveTurn(session.id);

      try {
        send("meta", {
          project_slug: project.slug,
          agent: resolved.agent_id,
          session_id: session.id,
          harness_adapter: project.harness_adapter,
          message_chars: body.message.length,
        });

        for await (const evt of adapter.execute({
          projectSlug: project.slug,
          agentId: resolved.agent_id,
          workspaceDir: workspaceDirFor(resolved.agent_id),
          message: body.message,
          threadId: session.id,
          harnessSessionId: session.harness_session_id,
          model,
          reasoningEffort,
          signal: ctrl.signal,
        })) {
          if (evt.kind === "session") {
            // Remember the harness's own session id so the next turn can
            // pass it back via --resume / `exec resume`. Don't persist as
            // a transcript event — it's metadata, not chat content.
            touchSession(session.id, evt.harnessSessionId);
            continue;
          }
          // A user-requested stop SIGTERMs the harness, which surfaces as a
          // nonzero-exit error from the adapter. That's the stop working,
          // not a failure — swallow it; the clean marker lands below.
          if (evt.kind === "error" && ctrl.signal.aborted) continue;
          try {
            appendTranscriptEvent(session.id, evt.kind, evt);
          } catch (err) {
            console.error("[api/chat] transcript persist failed:", err);
          }

          if (evt.kind === "delta") {
            send("text", { chunk: evt.text });
          } else if (evt.kind === "tool") {
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
        }

        if (ctrl.signal.aborted) {
          // Honest marker: the turn ended because the user stopped it, not
          // because the agent finished. The done lifecycle ends the
          // transcript's "still thinking" state for late attachers.
          appendTranscriptEvent(session.id, "error", {
            kind: "error",
            message: "Stopped by user.",
          });
          appendTranscriptEvent(session.id, "lifecycle", {
            kind: "lifecycle",
            phase: "done",
          });
        }
        touchSession(session.id);

        send("done", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("error", { message });
      } finally {
        releaseLiveTurn(session.id, ctrl);
        try {
          controller.close();
        } catch {
          // already closed
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

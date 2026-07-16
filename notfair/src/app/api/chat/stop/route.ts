import { NextResponse } from "next/server";
import { getActiveProject } from "@/server/active-project";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { findSession } from "@/server/sessions";
import { stopLiveTurn } from "@/server/sessions/live-turns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StopPostBody = {
  agent?: string;
  project?: string;
  thread?: string;
};

/**
 * The user's explicit stop click. Aborts the thread's in-flight chat turn
 * server-side (SIGTERM to the harness subprocess) — unlike a client
 * disconnect, which deliberately never cancels a running turn.
 */
export async function POST(request: Request) {
  let body: StopPostBody;
  try {
    body = (await request.json()) as StopPostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const project = body.project ? getProject(body.project) : await getActiveProject();
  if (!project) {
    return NextResponse.json({ error: "No active project." }, { status: 400 });
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

  const label = body.thread?.trim() || "main";
  const session = findSession(project.slug, resolved.agent_id, label);
  const stopped = session ? stopLiveTurn(session.id) : false;
  return NextResponse.json({ stopped });
}

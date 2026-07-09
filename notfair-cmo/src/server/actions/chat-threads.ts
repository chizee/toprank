"use server";

import { revalidatePath } from "next/cache";

import { resolveAgentBySlug } from "@/server/agent-meta";
import { getProject } from "@/server/db/projects";
import {
  deleteSession,
  setSessionPinned,
  setSessionTitle,
} from "@/server/sessions";
import { findSessionBySessionId } from "@/server/sessions/view";

export type ThreadActionResult = { ok: true } | { ok: false; error: string };

/**
 * Resolve (project, agent slug, thread label) → the sessions row id, with
 * ownership checks. The thread label is the UUID in the /chat/<label> URL;
 * SessionView.sessionKey carries the DB primary key.
 */
async function resolveThread(
  projectSlug: string,
  agentSlug: string,
  threadLabel: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const project = getProject(projectSlug);
  if (!project || project.archived_at) {
    return { ok: false, error: "Project not found." };
  }
  const agent = await resolveAgentBySlug(project.slug, agentSlug);
  if (!agent) return { ok: false, error: `Unknown agent '${agentSlug}'` };
  const session = findSessionBySessionId(
    project.slug,
    agent.agent_id,
    threadLabel,
  );
  if (!session) return { ok: false, error: "Thread not found." };
  return { ok: true, sessionId: session.sessionKey };
}

/** Rename a thread (empty title clears back to the derived preview). */
export async function renameThreadAction(input: {
  projectSlug: string;
  agentSlug: string;
  threadLabel: string;
  title: string;
}): Promise<ThreadActionResult> {
  const resolved = await resolveThread(
    input.projectSlug,
    input.agentSlug,
    input.threadLabel,
  );
  if (!resolved.ok) return resolved;
  setSessionTitle(resolved.sessionId, input.title);
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Pin or unpin a thread — pinned threads sort to the top of the rail. */
export async function setThreadPinnedAction(input: {
  projectSlug: string;
  agentSlug: string;
  threadLabel: string;
  pinned: boolean;
}): Promise<ThreadActionResult> {
  const resolved = await resolveThread(
    input.projectSlug,
    input.agentSlug,
    input.threadLabel,
  );
  if (!resolved.ok) return resolved;
  setSessionPinned(resolved.sessionId, input.pinned);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Permanently delete a thread and its transcript (FK cascade). The rail
 * confirms with the user before calling this.
 */
export async function deleteThreadAction(input: {
  projectSlug: string;
  agentSlug: string;
  threadLabel: string;
}): Promise<ThreadActionResult> {
  const resolved = await resolveThread(
    input.projectSlug,
    input.agentSlug,
    input.threadLabel,
  );
  if (!resolved.ok) return resolved;
  deleteSession(resolved.sessionId);
  revalidatePath("/", "layout");
  return { ok: true };
}

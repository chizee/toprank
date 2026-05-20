import { notFound } from "next/navigation";

import { AgentTaskWorkspace } from "@/components/agent-task-workspace";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { getTask, listTasksByAgent, setTaskThreadIfMissing } from "@/server/db/tasks";
import { buildPendingSessionKey, findSessionBySessionId } from "@/server/openclaw/sessions";
import {
  readTranscriptTail,
  type TranscriptEvent,
} from "@/server/openclaw/transcript-tail";
import { generateTaskThreadId } from "@/server/orchestration/process-blocks";
import { startTaskIfProposed } from "@/server/orchestration/run-task";
import type { Task } from "@/types";

type Props = {
  params: Promise<{ agent: string; project: string }>;
  searchParams: Promise<{ task?: string }>;
};

type SelectedBundle = {
  task: Task;
  threadId: string;
  sessionKey: string;
  initialEvents: TranscriptEvent[];
  initialByteOffset: number;
};

export default async function AgentTasksPage({ params, searchParams }: Props) {
  const [{ agent: agentSlug, project: projectSlug }, { task: selectedTaskId }] =
    await Promise.all([params, searchParams]);

  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();

  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  const agentFullId = resolved.agent_id;

  // Load the selected task's brief + transcript bundle if `?task=` is set.
  // This may auto-claim a proposed task → running, so it runs BEFORE the
  // task list is read — otherwise the list shows the pre-claim status
  // and the selected task appears under the wrong group.
  let selected: SelectedBundle | null = null;
  if (selectedTaskId) {
    selected = await loadSelectedBundle(agentFullId, selectedTaskId);
    // Guard: drop selection if it's not on this agent (cross-agent links etc).
    if (selected && selected.task.agent_id !== agentFullId) selected = null;
  }

  const tasks = listTasksByAgent(agentFullId);
  const proposedCount = tasks.filter((t) => t.status === "proposed").length;

  return (
    <AgentTaskWorkspace
      projectSlug={projectSlug}
      agentSlug={agentSlug}
      agentFullId={agentFullId}
      agentDisplayName={resolved.display_name}
      tasks={tasks}
      selected={selected}
      proposedCount={proposedCount}
    />
  );
}

async function loadSelectedBundle(
  agentFullId: string,
  taskId: string,
): Promise<SelectedBundle | null> {
  let task = getTask(taskId);
  if (!task) return null;

  // Lazily mint a per-task chat thread on first open. Stable forever after.
  if (!task.thread_id) {
    const updated = setTaskThreadIfMissing(task.id, generateTaskThreadId());
    if (updated) task = updated;
  }
  if (!task.thread_id) return null;
  const threadId = task.thread_id;

  // Atomically transition proposed → running and fire the kickoff. No-op
  // when the task isn't proposed, so reloading the page doesn't restart.
  task = startTaskIfProposed(task);

  // Resolve canonical sessionKey for /api/chat composer sends (when task
  // is done and user wants to keep chatting). The pending key is a safe
  // fallback for brand-new threads.
  const session = findSessionBySessionId(agentFullId, threadId);
  const sessionKey =
    session?.sessionKey ?? buildPendingSessionKey(agentFullId, threadId);

  const { events, byteOffset } = readTranscriptTail(agentFullId, threadId, 0);

  return {
    task,
    threadId,
    sessionKey,
    initialEvents: events,
    initialByteOffset: byteOffset,
  };
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import {
  getGoalForAgent,
  getLatestGoalForAgent,
  listGoalLearnings,
} from "@/server/db/goals";
import { readTranscriptTail } from "@/server/sessions/transcript-tail";
import { getMcpCatalog } from "@/server/mcp-catalog";
import { DEFAULT_HARNESS_ADAPTER, requireAdapter } from "@/server/adapters/registry";
import { projectHref } from "@/lib/project-href";
import { goalLabel } from "@/lib/goal-label";
import { LiveTranscript } from "@/components/live-transcript";
import { GoalContextDialog } from "@/components/goal-context-dialog";
import { GoalMemoryDialog } from "@/components/goal-memory-dialog";

export const dynamic = "force-dynamic";

/**
 * Conversation for one loop check (tick). Reached from the goal screen's
 * Checks list; follow-up turns resume the same harness session so the agent
 * keeps the check's exact context, tools, and transcript.
 */
export default async function CheckTranscriptPage({
  params,
}: {
  params: Promise<{ agent: string; thread: string; project: string }>;
}) {
  const { agent: agentSlug, thread: threadId, project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(slug, agentSlug);
  if (!resolved) notFound();
  const goal =
    getGoalForAgent(resolved.agent_id) ?? getLatestGoalForAgent(resolved.agent_id);

  const { events: initialEvents, cursor: initialCursor } = readTranscriptTail(
    slug,
    resolved.agent_id,
    threadId,
    0,
  );
  const mcpCatalog = getMcpCatalog(slug).map((m) => ({
    key: m.key,
    display_name: m.display_name,
    resource_url: m.resource_url,
  }));
  const modelOptions = await requireAdapter(
    project.harness_adapter ?? DEFAULT_HARNESS_ADAPTER,
  ).listModels();
  // A check runs as the same agent as the goal chat: identical identity,
  // tools, and learnings ledger — only the conversation is the tick's own.
  const learnings = goal ? listGoalLearnings(goal.id, 100) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 px-5 py-2.5">
        <Link
          href={projectHref(slug, `/goals/${agentSlug}`)}
          className="ns-btn ns-btn-outline ns-btn-sm shrink-0"
        >
          <ArrowLeft className="size-3.5" />
          Back to goal
        </Link>
        <h1 className="m-0 min-w-0 truncate text-[14px] font-semibold">
          {goal ? goalLabel(goal) : resolved.name} — check chat
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <GoalContextDialog
            projectSlug={slug}
            agentSlug={agentSlug}
            agentId={resolved.agent_id}
            threadId={threadId}
            models={modelOptions.map((m) => ({
              value: m.value,
              label: m.label,
              context_window: m.context_window,
              is_default: m.is_default,
            }))}
          />
          <GoalMemoryDialog
            entries={learnings.map((l) => ({
              id: l.id,
              body: l.body,
              confidence: l.confidence,
              created_at: l.created_at,
            }))}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <LiveTranscript
          key={threadId}
          projectSlug={slug}
          agentSlug={agentSlug}
          agentDisplayName={goal ? goalLabel(goal) : resolved.name}
          threadId={threadId}
          initialEvents={initialEvents}
          initialCursor={initialCursor}
          showCompletedStatus
          mcpCatalog={mcpCatalog}
          modelOptions={modelOptions}
        />
      </div>
    </div>
  );
}

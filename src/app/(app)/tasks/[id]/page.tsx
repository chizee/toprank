import Link from "next/link";
import { notFound } from "next/navigation";

import { AgentChat } from "@/components/agent-chat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getActiveProject } from "@/server/active-project";
import { readAgentMeta } from "@/server/agent-meta";
import { templateForKey, urlSlugForTemplate, type AgentTemplateKey } from "@/server/agent-templates";
import { listAgentActions } from "@/server/db/agent-actions";
import { getTask, setTaskThreadIfMissing } from "@/server/db/tasks";
import {
  buildPendingSessionKey,
  loadSessionHistory,
} from "@/server/openclaw/sessions";
import { buildTaskKickoffMessage } from "@/server/orchestration/task-kickoff";
import { generateTaskThreadId } from "@/server/orchestration/process-blocks";
import type { TaskStatus } from "@/types";

const STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  proposed: "outline",
  approved: "secondary",
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getActiveProject();
  if (!project) {
    return (
      <div className="mx-auto max-w-md pt-12 text-sm text-muted-foreground">
        Select a project to view this task.
      </div>
    );
  }

  let task = getTask(id);
  if (!task || task.project_slug !== project.slug) notFound();

  // Lazily mint a per-task chat thread on first open. Stable forever after
  // so the assignee's transcript for THIS task persists across visits.
  if (!task.thread_id) {
    const updated = setTaskThreadIfMissing(task.id, generateTaskThreadId());
    if (updated) task = updated;
  }
  const threadId = task.thread_id!;

  // Resolve the assignee's template + display info. The brief might predate
  // an agent rename / template rework, so be defensive.
  const meta = await readAgentMeta(task.agent_id);
  const templateKey = (meta?.template_key as AgentTemplateKey | undefined) ?? "google_ads";
  const template = templateForKey(templateKey);
  const agentSlug = meta?.slug ?? urlSlugForTemplate(templateKey);
  const agentDisplayName = meta?.display_name ?? template?.display_name ?? "Specialist";

  // Per-task chat history (an empty list when this is the first visit).
  const history = loadSessionHistory(task.agent_id, threadId);
  const sessionKey = buildPendingSessionKey(task.agent_id, threadId);
  const autoKickoff = history.length === 0;
  const kickoffMessage = autoKickoff ? buildTaskKickoffMessage(task) : undefined;

  // Comments + status updates on this task (rendered as an activity list above
  // the chat). Pulls from agent_actions filtered by task_id payload field.
  const activity = listAgentActions(project.slug, 50).filter((a) => {
    if (!a.payload_json) return false;
    try {
      const payload = JSON.parse(a.payload_json) as { task_id?: string };
      return payload.task_id === task!.id;
    } catch {
      return false;
    }
  });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-background/95 px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">
                <Link href="/tasks" className="hover:text-foreground hover:underline">
                  Tasks
                </Link>{" "}
                / <span className="font-mono">{task.id.slice(0, 8)}</span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight truncate">
                {task.title ?? "(untitled task)"}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={STATUS_VARIANT[task.status]}>{task.status}</Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                → {agentDisplayName}
              </Badge>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Brief</CardTitle>
              <CardDescription className="text-[10px]">
                Created {new Date(task.created_at).toLocaleString()}
                {task.assigner_agent_id ? ` by ${task.assigner_agent_id}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 pt-0 text-sm whitespace-pre-wrap">
              {task.brief}
              {task.success_criteria && (
                <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                  <span className="font-medium">Success criteria:</span>{" "}
                  {task.success_criteria}
                </div>
              )}
            </CardContent>
          </Card>

          {activity.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Task activity</CardTitle>
                <CardDescription className="text-[10px]">
                  {activity.length} event{activity.length === 1 ? "" : "s"} on this
                  task
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-0 text-xs">
                {activity.slice(0, 8).map((a) => (
                  <div key={a.id} className="flex items-baseline gap-2">
                    <Badge variant="outline" className="font-mono text-[9px]">
                      {a.action_type}
                    </Badge>
                    <span className="flex-1 truncate">{a.summary}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {new Date(a.occurred_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 border-t">
        <AgentChat
          key={threadId}
          projectSlug={project.slug}
          agentSlug={agentSlug}
          agentDisplayName={agentDisplayName}
          sessionId={threadId}
          sessionKey={sessionKey}
          templateKey={templateKey}
          initialMessages={history.map((m) => ({
            id: m.id,
            role: m.role,
            body: m.body,
          }))}
          autoKickoff={autoKickoff}
          kickoffMessage={kickoffMessage}
        />
      </div>
    </div>
  );
}

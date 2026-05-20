import { notFound, redirect } from "next/navigation";

import { readAgentMeta } from "@/server/agent-meta";
import { getActiveProject } from "@/server/active-project";
import { getTask } from "@/server/db/tasks";
import { urlSlugForTemplate, type AgentTemplateKey } from "@/server/agent-templates";

/**
 * Deep-link destination for task IDs. The canonical view lives in the agent
 * workspace, so we resolve the task's owning agent and redirect there with
 * the task pre-selected. Keeps existing orchestration-summary links + emails
 * + bookmarks working through the rework.
 */
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

  const task = getTask(id);
  if (!task || task.project_slug !== project.slug) notFound();

  // Resolve the assignee's URL slug. Templates predate cloned agents — fall
  // back to the template default if no per-agent slug is stored.
  const meta = await readAgentMeta(task.agent_id);
  const templateKey = (meta?.template_key as AgentTemplateKey | undefined) ?? "google_ads";
  const agentSlug = meta?.slug ?? urlSlugForTemplate(templateKey);

  // Use the human-readable display_id in the canonical URL so the path
  // someone bookmarks reads "?task=demo7-3" not a UUID. getTask in the
  // workspace accepts either form, so legacy UUID deep-links still resolve.
  redirect(`/agents/${agentSlug}/tasks?task=${task.display_id}`);
}

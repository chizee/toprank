import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StartAllTasksButton } from "@/components/start-all-tasks-button";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { listTasksByAgent } from "@/server/db/tasks";
import type { Task, TaskStatus } from "@/types";

const STATUS_GROUPS: Array<{ status: TaskStatus; label: string }> = [
  { status: "proposed", label: "Proposed" },
  { status: "running", label: "In progress" },
  { status: "succeeded", label: "Done" },
  { status: "failed", label: "Failed" },
  { status: "cancelled", label: "Cancelled" },
];

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

export default async function AgentTasksPage({
  params,
}: {
  params: Promise<{ agent: string }>;
}) {
  const { agent: agentSlug } = await params;
  const project = await getActiveProject();
  if (!project) {
    return (
      <div className="mx-auto max-w-md p-6 pt-12 text-sm text-muted-foreground">
        Select a project to view this agent&rsquo;s tasks.
      </div>
    );
  }

  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  const agentFullId = resolved.agent_id;
  const tasks = listTasksByAgent(agentFullId);
  const proposedCount = tasks.filter((t) => t.status === "proposed").length;
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const t of tasks) {
    const list = byStatus.get(t.status) ?? [];
    list.push(t);
    byStatus.set(t.status, list);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {resolved.display_name} &middot; Tasks
          </h1>
          <p className="text-sm text-muted-foreground">
            {tasks.length === 0
              ? "Nothing assigned yet."
              : `${tasks.length} total · ${proposedCount} ready to start`}
          </p>
        </div>
        {proposedCount > 0 && (
          <StartAllTasksButton agentId={agentFullId} proposedCount={proposedCount} />
        )}
      </header>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No tasks assigned to {resolved.display_name} yet. The CMO will create
            tasks here when it delegates work.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {STATUS_GROUPS.map((group) => {
            const items = byStatus.get(group.status) ?? [];
            if (items.length === 0) return null;
            return (
              <Card key={group.status}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm font-medium">
                    {group.label}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {items.length}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {items.map((t) => (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}`}
                      className="block rounded-md border bg-card p-3 text-xs space-y-1 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge
                          variant={STATUS_VARIANT[t.status]}
                          className="text-[10px]"
                        >
                          {t.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {new Date(t.updated_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="line-clamp-2 font-medium text-foreground">
                        {t.title ?? t.brief}
                      </p>
                      {t.title && (
                        <p className="line-clamp-2 text-muted-foreground">
                          {t.brief}
                        </p>
                      )}
                      {t.status === "failed" && t.error_message && (
                        <p className="line-clamp-2 text-destructive">
                          {t.error_message}
                        </p>
                      )}
                    </Link>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

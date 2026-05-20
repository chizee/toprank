import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getActiveProject } from "@/server/active-project";
import { listTasks } from "@/server/db/tasks";
import type { TaskStatus } from "@/types";

const STATUS_GROUPS: Array<{ status: TaskStatus; label: string }> = [
  { status: "proposed", label: "Proposed" },
  { status: "approved", label: "Approved" },
  { status: "running", label: "Running" },
  { status: "succeeded", label: "Succeeded" },
  { status: "failed", label: "Failed" },
  { status: "cancelled", label: "Cancelled" },
];

const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "outline" | "destructive"> = {
  proposed: "outline",
  approved: "secondary",
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

export default async function TasksPage() {
  const project = await getActiveProject();
  if (!project) {
    return (
      <div className="mx-auto max-w-md pt-12 text-sm text-muted-foreground">
        Select a project to see its tasks.
      </div>
    );
  }

  const tasks = listTasks(project.slug);
  const byStatus = new Map<TaskStatus, typeof tasks>();
  for (const t of tasks) {
    const list = byStatus.get(t.status) ?? [];
    list.push(t);
    byStatus.set(t.status, list);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          {tasks.length} total · CMO and specialist agents create tasks here as they
          delegate work.
        </p>
      </header>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No tasks yet. Ask your CMO to do something in chat to populate this board.
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
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[t.status]} className="text-[10px]">
                          {t.agent_id}
                        </Badge>
                      </div>
                      <p className="font-medium text-foreground line-clamp-2">
                        {t.title ?? t.brief}
                      </p>
                      {t.title && (
                        <p className="line-clamp-2 text-muted-foreground">{t.brief}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(t.updated_at).toLocaleString()}
                      </p>
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

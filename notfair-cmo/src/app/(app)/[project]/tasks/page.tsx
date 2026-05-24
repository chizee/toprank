import { notFound } from "next/navigation";

import { TasksBoard } from "@/components/tasks-board";
import { listProjectAgents } from "@/server/agent-meta";
import { getProject } from "@/server/db/projects";
import { listTasks } from "@/server/db/tasks";

export default async function TasksPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();

  // listTasks returns DESC by created_at; the board re-sorts where needed
  // (list view is updated_at desc; kanban keeps insertion order within
  // a column, which matches "newest at top").
  const [tasks, agents] = await Promise.all([
    Promise.resolve(listTasks(project.slug)),
    listProjectAgents(project.slug),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"} · CMO and
          specialist agents create tasks here as they delegate work.
        </p>
      </header>

      <TasksBoard projectSlug={project.slug} tasks={tasks} agents={agents} />
    </div>
  );
}

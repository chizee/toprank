import { notFound } from "next/navigation";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { AgentTabs } from "@/components/agent-tabs";

type Params = { agent: string; project: string };

export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<Params>;
}) {
  const { agent: agentSlug, project: projectSlug } = await params;
  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  return (
    // Escape parent main's p-6 so the tab strip + content area can own the
    // full viewport region. Children pick their own scroll/padding strategy.
    <div className="absolute inset-0 flex flex-col">
      <AgentTabs projectSlug={projectSlug} agentSlug={agentSlug} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

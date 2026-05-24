import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { getSkillStatus } from "@/server/openclaw/gateway-rpc";
import { SkillsList } from "@/components/skills-list";

type Params = { agent: string; project: string };

export default async function AgentSkillsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { agent: agentSlug, project: projectSlug } = await params;
  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  const agentFullId = resolved.agent_id;
  let report: Awaited<ReturnType<typeof getSkillStatus>> | null = null;
  let error: string | null = null;
  try {
    report = await getSkillStatus(agentFullId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const skills = report?.skills ?? [];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <header>
          <h2 className="text-lg font-semibold tracking-tight">Skills</h2>
          <p className="text-sm text-muted-foreground">
            Capabilities OpenClaw exposes to {resolved.name}.
            {report?.agentSkillFilter?.length
              ? ` Filtered to this agent's allowlist (${report.agentSkillFilter.length}).`
              : " Workspace-wide; no per-agent filter."}
          </p>
        </header>

        {error && (
          <Card>
            <CardContent className="space-y-1 py-4 text-sm">
              <p className="font-medium text-destructive">Could not reach OpenClaw.</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {!error && skills.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No skills installed in this workspace yet.
            </CardContent>
          </Card>
        )}

        {!error && skills.length > 0 && (
          <SkillsList skills={skills} agentSlug={agentSlug} />
        )}
      </div>
    </div>
  );
}

import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { TEMPLATES } from "@/server/agent-templates";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug, readAgentMeta } from "@/server/agent-meta";
import { AgentDangerZone } from "@/components/agent-danger-zone";

type Params = { agent: string; project: string };

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { agent: agentSlug, project: projectSlug } = await params;
  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  const meta = readAgentMeta(resolved.agent_id);
  const role = resolved.template_key
    ? TEMPLATES.find((t) => t.key === resolved.template_key)
    : undefined;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            {resolved.name}{" "}
            <span className="font-mono text-xs">· {resolved.agent_id}</span>
          </p>
        </header>

        <Card>
          <CardContent className="p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{resolved.name}</dd>

              {role && (
                <>
                  <dt className="text-muted-foreground">Role</dt>
                  <dd>{role.display_name}</dd>
                </>
              )}

              <dt className="text-muted-foreground">URL slug</dt>
              <dd className="font-mono text-xs">{resolved.slug}</dd>

              <dt className="text-muted-foreground">Agent id</dt>
              <dd className="font-mono text-xs">{resolved.agent_id}</dd>

              {meta?.source_agent_id && (
                <>
                  <dt className="text-muted-foreground">Cloned from</dt>
                  <dd className="font-mono text-xs">{meta.source_agent_id}</dd>
                </>
              )}

              {meta?.created_at && (
                <>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="tabular-nums">
                    {new Date(meta.created_at).toLocaleString()}
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              Agent identity is immutable. The name set at onboarding stays
              fixed for the life of the project; the URL slug is computed
              from the role + name.
            </p>
          </CardContent>
        </Card>

        <section className="space-y-2 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Danger zone
          </h3>
          <AgentDangerZone
            agentId={resolved.agent_id}
            agentDisplayName={resolved.name}
          />
        </section>
      </div>
    </div>
  );
}

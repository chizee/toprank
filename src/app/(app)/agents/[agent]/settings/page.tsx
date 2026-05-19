import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug, readAgentMeta } from "@/server/agent-meta";
import { AgentDangerZone } from "@/components/agent-danger-zone";
import { AgentRenameCard } from "@/components/agent-rename-card";

type Params = { agent: string };

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { agent: agentSlug } = await params;
  const project = await getActiveProject();
  const resolved = project ? await resolveAgentBySlug(project.slug, agentSlug) : null;
  if (project && !resolved) notFound();

  if (!project || !resolved) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-2 p-6">
            <h2 className="text-base font-medium">No active project</h2>
            <p className="text-sm text-muted-foreground">
              Create a project to edit agent settings.
            </p>
            <Link href="/onboarding" className="text-sm underline">
              Create one
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const meta = readAgentMeta(resolved.agent_id);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            {resolved.display_name}{" "}
            <span className="font-mono text-xs">· {resolved.agent_id}</span>
          </p>
        </header>

        <Card>
          <CardContent className="p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Agent id</dt>
              <dd className="font-mono text-xs">{resolved.agent_id}</dd>

              <dt className="text-muted-foreground">URL slug</dt>
              <dd className="font-mono text-xs">{resolved.slug}</dd>

              <dt className="text-muted-foreground">Display name</dt>
              <dd>{resolved.display_name}</dd>

              {resolved.template_key && (
                <>
                  <dt className="text-muted-foreground">Template</dt>
                  <dd className="font-mono text-xs">{resolved.template_key}</dd>
                </>
              )}

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
          </CardContent>
        </Card>

        <AgentRenameCard
          agentId={resolved.agent_id}
          projectSlug={project.slug}
          currentDisplayName={resolved.display_name}
          currentSlug={resolved.slug}
        />

        <section className="space-y-2 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Danger zone
          </h3>
          <AgentDangerZone
            agentId={resolved.agent_id}
            agentDisplayName={resolved.display_name}
          />
        </section>
      </div>
    </div>
  );
}

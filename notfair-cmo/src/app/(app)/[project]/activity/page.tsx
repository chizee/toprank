import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getProject } from "@/server/db/projects";
import { listAgentActions } from "@/server/db/agent-actions";

function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();
  const actions = listAgentActions(project.slug, 200);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Project <span className="font-mono">{project.slug}</span> · {actions.length} actions ·
          append-only audit log
        </p>
      </header>

      {actions.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 py-12 text-center text-sm">
            <h2 className="text-base font-medium">No activity yet.</h2>
            <p className="text-muted-foreground">
              Every autonomous decision and scheduled job lands here for auditing.
              When you provision agents or schedule crons, the events show up.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {actions.map((a) => (
                <li key={a.id} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex items-baseline gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {a.action_type}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {a.agent_id}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {timeAgo(a.occurred_at)} · {new Date(a.occurred_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="leading-snug">{a.summary}</p>
                  {a.reasoning && (
                    <p className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground whitespace-pre-wrap">
                      {a.reasoning}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Force this page to re-render on every visit so freshly-logged actions show up
// without a hard refresh.
export const dynamic = "force-dynamic";

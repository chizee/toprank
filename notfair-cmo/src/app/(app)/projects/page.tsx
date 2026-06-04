import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { listProjects } from "@/server/db/projects";

export default function ProjectsListPage() {
  const projects = listProjects({ includeArchived: true });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
          <p className="text-sm text-muted-foreground">{projects.length} total</p>
        </div>
        <Button asChild>
          <Link href="/onboarding">New workspace</Link>
        </Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No workspaces yet.{" "}
            <Link className="underline" href="/onboarding">
              Create your first one
            </Link>
            .
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <Card key={p.slug}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">{p.display_name}</CardTitle>
                {p.archived_at && <Badge variant="outline">archived</Badge>}
              </CardHeader>
              <CardContent className="flex items-center justify-between pt-0 text-xs text-muted-foreground">
                <span className="font-mono">{p.slug}</span>
                <span>Created {new Date(p.created_at).toLocaleDateString()}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

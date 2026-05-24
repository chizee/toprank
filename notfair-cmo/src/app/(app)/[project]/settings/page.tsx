import { notFound } from "next/navigation";
import { getProject } from "@/server/db/projects";
import { DangerZone } from "@/components/danger-zone";
import { ProjectRenameCard } from "@/components/project-rename-card";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Project <span className="font-mono">{project.slug}</span>
        </p>
      </header>

      <ProjectRenameCard
        currentSlug={project.slug}
        currentDisplayName={project.display_name}
      />

      <section className="space-y-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Danger zone
        </h2>
        <DangerZone projectSlug={project.slug} projectName={project.display_name} />
      </section>
    </div>
  );
}

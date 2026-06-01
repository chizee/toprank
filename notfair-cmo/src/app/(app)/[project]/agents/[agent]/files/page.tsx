import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, FileX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { listAgentFiles, getAgentFile } from "@/server/agents/files";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/project-href";

type AugmentedFile = Awaited<ReturnType<typeof listAgentFiles>>["files"][number];

type Params = { agent: string; project: string };
type Search = { file?: string };

export default async function AgentFilesPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { agent: agentSlug, project: projectSlug } = await params;
  const { file: requestedFile } = await searchParams;

  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();

  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();
  const agentFullId = resolved.agent_id;

  let error: string | null = null;
  let files: AugmentedFile[] = [];
  let workspace = "";
  try {
    const list = await listAgentFiles(agentFullId);
    files = list.files;
    workspace = list.workspace;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // listAgentFiles already enumerates every workspace file from disk
  // (including PROJECT.md when present), so no augment splice is needed.
  // Reorder so PROJECT.md sits right after IDENTITY.md when both exist,
  // matching the v0.1.0 reading order without duplicating entries.
  const identityIdx = files.findIndex((f) => f.name === "IDENTITY.md");
  const projectIdx = files.findIndex((f) => f.name === "PROJECT.md");
  if (identityIdx >= 0 && projectIdx >= 0 && projectIdx !== identityIdx + 1) {
    const project = files[projectIdx]!;
    const without = files.filter((_, i) => i !== projectIdx);
    const insertAt = without.findIndex((f) => f.name === "IDENTITY.md") + 1;
    files = [...without.slice(0, insertAt), project, ...without.slice(insertAt)];
  }

  // Pick which file to show: explicit search param wins, else first present
  // file, else first overall (which may be missing).
  const selectedName =
    (requestedFile && files.find((f) => f.name === requestedFile)?.name) ||
    files.find((f) => !f.missing)?.name ||
    files[0]?.name;

  let selectedContent: string | null = null;
  let selectedSize: number | undefined;
  let selectedUpdatedAtMs: number | undefined;
  let selectedMissing = false;
  let selectedError: string | null = null;
  if (selectedName) {
    const entry = files.find((f) => f.name === selectedName);
    selectedMissing = entry?.missing ?? true;
    if (!selectedMissing) {
      try {
        const got = await getAgentFile(agentFullId, selectedName);
        selectedContent = got.file.content;
        selectedSize = got.file.size;
        selectedUpdatedAtMs = got.file.updatedAtMs;
      } catch (err) {
        selectedError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)] divide-x">
      {/* Left rail — file list */}
      <aside className="flex min-h-0 flex-col">
        <div className="border-b px-4 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Workspace files
          </div>
          {workspace && (
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
              {workspace}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {error && (
            <div className="px-4 py-3 text-xs text-destructive">{error}</div>
          )}
          {!error && files.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No files yet.
            </div>
          )}
          {files.map((f) => {
            const isActive = f.name === selectedName;
            return (
              <Link
                key={f.name}
                href={projectHref(
                  projectSlug,
                  `/agents/${agentSlug}/files?file=${encodeURIComponent(f.name)}`,
                )}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                  f.missing && "text-muted-foreground/70",
                )}
              >
                {f.missing ? (
                  <FileX className="size-3.5 shrink-0 opacity-60" />
                ) : (
                  <FileText className="size-3.5 shrink-0" />
                )}
                <span className="truncate font-mono text-[13px]">{f.name}</span>
                {f.missing && (
                  <Badge
                    variant="outline"
                    className="ml-auto h-4 px-1 text-[9px] uppercase tracking-wide"
                  >
                    empty
                  </Badge>
                )}
              </Link>
            );
          })}
        </div>
      </aside>

      {/* Right pane — file viewer */}
      <section className="flex min-h-0 flex-col">
        {!selectedName ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Select a file to view its contents.
          </div>
        ) : selectedMissing ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <FileX className="size-6 text-muted-foreground/60" />
            <div className="text-sm text-muted-foreground">
              <span className="font-mono">{selectedName}</span> does not exist yet for this agent.
            </div>
            <div className="text-xs text-muted-foreground/80">
              The agent may create it during onboarding or when first invoked.
            </div>
          </div>
        ) : selectedError ? (
          <div className="p-6 text-sm text-destructive">{selectedError}</div>
        ) : (
          <>
            <header className="flex items-center justify-between border-b px-6 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm">{selectedName}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {selectedSize !== undefined && `${formatBytes(selectedSize)}`}
                  {selectedSize !== undefined && selectedUpdatedAtMs && " · "}
                  {selectedUpdatedAtMs &&
                    `updated ${new Date(selectedUpdatedAtMs).toLocaleString()}`}
                </div>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed">
                {selectedContent}
              </pre>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

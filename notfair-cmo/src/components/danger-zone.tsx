"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getProjectDeletionSummaryAction,
  deleteProjectAction,
} from "@/server/actions/projects";
import type { ProjectDeletionSummary } from "@/server/openclaw/project-delete";

type Props = {
  projectSlug: string;
  projectName: string;
};

export function DangerZone({ projectSlug, projectName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<ProjectDeletionSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) {
      setSummary(null);
      setSummaryError(null);
      return;
    }
    setLoadingSummary(true);
    (async () => {
      const r = await getProjectDeletionSummaryAction(projectSlug);
      if (r.ok) setSummary(r.data);
      else setSummaryError(r.error);
      setLoadingSummary(false);
    })();
  }, [open, projectSlug]);

  const canDelete = !pending && !loadingSummary;

  function onConfirm() {
    startTransition(async () => {
      const r = await deleteProjectAction(projectSlug, projectSlug);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const d = r.data;
      const partial = d.agentsFailed.length + d.cronsFailed;
      if (partial > 0) {
        toast.warning(
          `Deleted with ${partial} issue${partial === 1 ? "" : "s"}. ` +
            `${d.agents.length} agents, ${d.crons} crons removed.`,
        );
      } else {
        toast.success(`Deleted ${projectName}. ${d.agents.length} agents, ${d.crons} crons removed.`);
      }
      setOpen(false);
      router.push("/");
      router.refresh();
    });
  }

  return (
    <>
      <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-destructive">Delete this project</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Removes all agents created for this project, every scheduled cron job, and
              every thread of chat history. This cannot be undone.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setOpen(true)}
            className="shrink-0"
          >
            <Trash2 className="mr-1.5 size-3.5" />
            Delete project
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-destructive" />
              Delete &ldquo;{projectName}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              This will permanently delete the items below from OpenClaw and notfair-cmo&apos;s
              local store. There is no recovery.
            </DialogDescription>
          </DialogHeader>

          {loadingSummary ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Counting what will be removed…
            </div>
          ) : summaryError ? (
            <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              Could not load deletion summary: {summaryError}
            </div>
          ) : summary ? (
            <div className="space-y-3">
              <div className="grid grid-cols-4 divide-x rounded-lg border bg-card">
                <Stat label="Agents" value={summary.totals.agents} />
                <Stat label="Threads" value={summary.totals.threads} />
                <Stat label="Crons" value={summary.totals.crons} />
                <Stat label="MCPs" value={summary.totals.mcps} />
              </div>
              {summary.agents.some((a) => a.exists) && (
                <ul className="space-y-1 text-xs">
                  {summary.agents
                    .filter((a) => a.exists)
                    .map((a) => (
                      <li key={a.agentId} className="flex items-center justify-between gap-2">
                        <span>
                          {a.display_name}{" "}
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {a.agentId}
                          </span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {a.threadCount} thread{a.threadCount === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirm}
              disabled={!canDelete}
            >
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="mr-1.5 size-3.5" />
                  Delete forever
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 py-2 text-center">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

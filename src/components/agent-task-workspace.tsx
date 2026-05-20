"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
  StopCircle,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LiveTranscript } from "@/components/live-transcript";
import { RunningDot } from "@/components/running-dot";
import { StartAllTasksButton } from "@/components/start-all-tasks-button";
import { cancelTaskAction } from "@/server/actions/tasks";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/project-href";
import type { TranscriptEvent } from "@/server/openclaw/transcript-tail";
import type { Task, TaskStatus } from "@/types";

const TASK_IN_FLIGHT: TaskStatus[] = ["proposed", "approved", "running"];

const STATUS_GROUPS: Array<{ status: TaskStatus; label: string }> = [
  { status: "running", label: "Running" },
  { status: "proposed", label: "Proposed" },
  { status: "approved", label: "Approved" },
  { status: "succeeded", label: "Done" },
  { status: "failed", label: "Failed" },
  { status: "cancelled", label: "Cancelled" },
];

const STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  proposed: "outline",
  approved: "secondary",
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

type SelectedTaskBundle = {
  task: Task;
  threadId: string;
  sessionKey: string;
  initialEvents: TranscriptEvent[];
  initialByteOffset: number;
};

type Props = {
  projectSlug: string;
  agentSlug: string;
  agentFullId: string;
  agentDisplayName: string;
  tasks: Task[];
  selected: SelectedTaskBundle | null;
  proposedCount: number;
};

export function AgentTaskWorkspace({
  projectSlug,
  agentSlug,
  agentFullId,
  agentDisplayName,
  tasks,
  selected,
  proposedCount,
}: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const selectedId = search.get("task");

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const t of tasks) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    return map;
  }, [tasks]);

  const totalCount = tasks.length;
  const inFlightCount =
    (grouped.get("running")?.length ?? 0) +
    (grouped.get("proposed")?.length ?? 0) +
    (grouped.get("approved")?.length ?? 0);

  function selectTask(displayId: string) {
    const params = new URLSearchParams(search?.toString() ?? "");
    params.set("task", displayId);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Background liveness polling is handled at the sidebar level
          (GlobalLivenessPoller) so it covers every route, not just this
          workspace. The per-thread LiveTranscript polling still handles
          the open transcript. */}
      {/* ── Left pane: task list ─────────────────────────────────────── */}
      <aside className="flex w-80 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {agentDisplayName} · Tasks
            </h2>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {totalCount}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {inFlightCount > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <RunningDot size="sm" aria-label="" />
                <span className="tabular-nums">{inFlightCount}</span> in flight
              </span>
            ) : totalCount === 0 ? (
              "Nothing assigned yet."
            ) : (
              "All quiet."
            )}
          </p>
          {proposedCount > 0 && (
            <div className="mt-2">
              <StartAllTasksButton
                agentId={agentFullId}
                proposedCount={proposedCount}
              />
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {totalCount === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              The CMO will delegate tasks here.
            </div>
          ) : (
            STATUS_GROUPS.map((group) => {
              const items = grouped.get(group.status);
              if (!items || items.length === 0) return null;
              return (
                <div key={group.status} className="py-1">
                  <div className="flex items-center justify-between px-4 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {group.label}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {items.length}
                    </span>
                  </div>
                  <ul>
                    {items.map((t) => (
                      <li key={t.id}>
                        <TaskRow
                          task={t}
                          selected={
                            t.display_id === selectedId || t.id === selectedId
                          }
                          onSelect={() => selectTask(t.display_id)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Right pane: brief header + live transcript ───────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="border-b bg-background/60 backdrop-blur">
              <div className="mx-auto w-full max-w-3xl px-6 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      <Link
                        href={projectHref(projectSlug, "/tasks")}
                        className="hover:text-foreground"
                      >
                        Tasks
                      </Link>
                      <span>/</span>
                      <span className="font-mono">{selected.task.display_id}</span>
                    </div>
                    <h1 className="mt-0.5 text-base font-semibold tracking-tight truncate">
                      {selected.task.title ?? "(untitled task)"}
                    </h1>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {(selected.task.status === "running" ||
                      selected.task.status === "proposed" ||
                      selected.task.status === "approved") && (
                      <>
                        <RunningDot size="md" />
                        <CancelTaskButton
                          taskDisplayId={selected.task.display_id}
                        />
                      </>
                    )}
                    <Badge
                      variant={STATUS_VARIANT[selected.task.status]}
                      className="text-[10px]"
                    >
                      {selected.task.status}
                    </Badge>
                  </div>
                </div>
                <details className="group mt-2">
                  <summary className="flex cursor-pointer select-none items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
                    <span className="transition-transform group-open:rotate-90">›</span>
                    Brief
                  </summary>
                  <div className="mt-2 space-y-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
                    {selected.task.brief}
                    {selected.task.success_criteria && (
                      <div className="mt-2 border-l-2 border-muted pl-3 text-xs">
                        <span className="font-medium text-foreground">
                          Success criteria:
                        </span>{" "}
                        {selected.task.success_criteria}
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </header>

            <div className="min-h-0 flex-1">
              <SelectedTaskPanel
                selected={selected}
                projectSlug={projectSlug}
                agentSlug={agentSlug}
                agentDisplayName={agentDisplayName}
              />
            </div>
          </>
        ) : (
          <EmptyRightPane
            agentDisplayName={agentDisplayName}
            hasTasks={totalCount > 0}
          />
        )}
      </section>
    </div>
  );
}

function SelectedTaskPanel({
  selected,
  projectSlug,
  agentSlug,
  agentDisplayName,
}: {
  selected: SelectedTaskBundle;
  projectSlug: string;
  agentSlug: string;
  agentDisplayName: string;
}) {
  const router = useRouter();
  const isInFlight = TASK_IN_FLIGHT.includes(selected.task.status);
  // Each time polling returns new events we refresh the server tree so
  // the status badge in this panel's header + the task list grouping
  // catch up to the JSONL — the LiveTranscript handles its own rendering
  // updates, this hook just rebroadcasts to the rest of the page.
  //
  // Double-refresh: when the agent emits its final reply (with the
  // <task_status>done</task_status> block), the JSONL bytes can land
  // BEFORE processOrchestrationBlocks runs the DB status flip. The
  // 600ms delayed refresh catches that follow-up DB write so the badge
  // updates without the user having to manually reload.
  const onPolled = useCallback(
    ({ newEvents }: { newEvents: number; fileSize: number }) => {
      if (newEvents > 0) {
        router.refresh();
        setTimeout(() => router.refresh(), 600);
      }
      // Return true to stop polling once the task is terminal AND the
      // poll returned nothing new (transcript fully drained).
      if (!isInFlight && newEvents === 0) return true;
      return false;
    },
    [isInFlight, router],
  );
  return (
    <LiveTranscript
      key={selected.task.id}
      projectSlug={projectSlug}
      agentSlug={agentSlug}
      agentDisplayName={agentDisplayName}
      threadId={selected.threadId}
      sessionKey={selected.sessionKey}
      initialEvents={selected.initialEvents}
      initialByteOffset={selected.initialByteOffset}
      composerDisabled={isInFlight}
      onPolled={onPolled}
    />
  );
}

function CancelTaskButton({ taskDisplayId }: { taskDisplayId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  function onClick() {
    if (!confirming) {
      setConfirming(true);
      // Auto-clear the confirm prompt after a few seconds so the button
      // doesn't sit in a scary "click again to cancel" state forever.
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    startTransition(async () => {
      const r = await cancelTaskAction(taskDisplayId);
      if (!r.ok) {
        toast.error(r.error);
        setConfirming(false);
        return;
      }
      toast.success("Task cancelled.");
      setConfirming(false);
      router.refresh();
    });
  }
  return (
    <Button
      type="button"
      variant={confirming ? "destructive" : "outline"}
      size="sm"
      disabled={pending}
      onClick={onClick}
      className="h-7 px-2 text-[11px]"
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <StopCircle className="size-3" />
      )}
      {confirming ? "Click again to cancel" : "Cancel"}
    </Button>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}) {
  const isRunning = task.status === "running";
  const isInFlight =
    task.status === "running" ||
    task.status === "proposed" ||
    task.status === "approved";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group block w-full px-4 py-2.5 text-left transition-colors",
        "hover:bg-accent/40 focus-visible:outline-none focus-visible:bg-accent/40",
        selected && "bg-accent/80 hover:bg-accent/80",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {isRunning ? (
            <RunningDot size="md" aria-label="Running" />
          ) : (
            <StatusGlyph status={task.status} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="mr-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">
            {task.display_id}
          </span>
          <span
            className={cn(
              selected ? "font-medium text-foreground" : "text-foreground/90",
              !isInFlight && task.status !== "running" && "text-muted-foreground",
            )}
          >
            {task.title ?? task.brief.slice(0, 80)}
          </span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatRelative(task.updated_at)}
        </span>
      </div>
      {task.status === "failed" && task.error_message && (
        <div className="ml-6 mt-1 line-clamp-1 text-[10px] text-destructive/80">
          {task.error_message}
        </div>
      )}
    </button>
  );
}

function StatusGlyph({ status }: { status: TaskStatus }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="size-3.5 text-emerald-600" />;
    case "failed":
      return <XCircle className="size-3.5 text-destructive" />;
    case "cancelled":
      return <Circle className="size-3.5 text-muted-foreground" />;
    case "approved":
      return <CircleDot className="size-3.5 text-sky-600" />;
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-sky-600" />;
    case "proposed":
    default:
      return <Circle className="size-3.5 text-muted-foreground" />;
  }
}

function EmptyRightPane({
  agentDisplayName,
  hasTasks,
}: {
  agentDisplayName: string;
  hasTasks: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="space-y-2 max-w-sm">
        <h3 className="text-sm font-medium">
          {hasTasks ? "Select a task" : `${agentDisplayName} has no tasks yet`}
        </h3>
        <p className="text-xs text-muted-foreground">
          {hasTasks
            ? "Pick one from the left to see its brief and live transcript."
            : "When the CMO delegates work to this specialist, tasks will land here. Open the CMO and ask it to plan the next move."}
        </p>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const delta = Date.now() - t;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  return `${day}d`;
}

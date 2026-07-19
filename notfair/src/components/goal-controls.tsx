"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MoreHorizontal, Pause, Play, Square, Zap } from "lucide-react";
import {
  killGoalAction,
  pauseGoalAction,
  resumeGoalAction,
  runTickNowAction,
} from "@/server/actions/goals";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Live-goal controls, sized for the chip row. "Run check" stays a
 * first-class chip — it's the one control used daily. Pause/resume and
 * Close live behind the ⋯ overflow: needed, but rare enough that they
 * shouldn't spend header space or invite misclicks next to daily chips.
 */
export function GoalControls({
  goalId,
  status,
}: {
  goalId: string;
  status: "active" | "paused" | "intake" | "proposed";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [killOpen, setKillOpen] = useState(false);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMsg: string,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Action failed.");
        return;
      }
      toast.success(successMsg);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {status === "active" && (
        <button
          type="button"
          className="ns-chip"
          aria-label="Run check now"
          disabled={pending}
          onClick={() => run(() => runTickNowAction(goalId), "Check started — watch the diary.")}
        >
          <Zap aria-hidden />
          <span className="hidden sm:inline">Run check</span>
        </button>
      )}
      {status === "paused" && (
        <button
          type="button"
          className="ns-chip"
          aria-label="Resume goal"
          disabled={pending}
          onClick={() => run(() => resumeGoalAction(goalId), "Goal resumed — heartbeat restarted.")}
        >
          <Play aria-hidden />
          <span className="hidden sm:inline">Resume</span>
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ns-chip !px-1.5"
            aria-label="More goal actions"
            disabled={pending}
          >
            <MoreHorizontal aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {status === "active" && (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => run(() => pauseGoalAction(goalId), "Goal paused.")}
            >
              <Pause />
              Pause the loop
            </DropdownMenuItem>
          )}
          {status === "paused" && (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                run(() => resumeGoalAction(goalId), "Goal resumed — heartbeat restarted.")
              }
            >
              <Play />
              Resume the loop
            </DropdownMenuItem>
          )}
          {(status === "active" || status === "paused") && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => setKillOpen(true)}
          >
            <Square />
            Close goal…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={killOpen} onOpenChange={setKillOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close this goal?</DialogTitle>
            <DialogDescription>
              The loop stops permanently and the goal moves to history. This
              can&rsquo;t be undone — you&rsquo;d start a fresh goal instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillOpen(false)} disabled={pending}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setKillOpen(false);
                run(() => killGoalAction(goalId), "Goal closed.");
              }}
            >
              Close goal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pause, Play, Square, Zap } from "lucide-react";
import {
  killGoalAction,
  pauseGoalAction,
  resumeGoalAction,
  runTickNowAction,
} from "@/server/actions/goals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Pause / resume / run-tick-now / close controls for a live goal. */
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
        <>
          <Button
            variant="outline"
            size="sm"
            aria-label="Run tick now"
            disabled={pending}
            onClick={() => run(() => runTickNowAction(goalId), "Tick started — watch the diary.")}
          >
            <Zap className="size-3.5" />
            <span className="hidden sm:inline">Run tick now</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Pause goal"
            disabled={pending}
            onClick={() => run(() => pauseGoalAction(goalId), "Goal paused.")}
          >
            <Pause className="size-3.5" />
            <span className="hidden sm:inline">Pause</span>
          </Button>
        </>
      )}
      {status === "paused" && (
        <Button
          variant="outline"
          size="sm"
          aria-label="Resume goal"
          disabled={pending}
          onClick={() => run(() => resumeGoalAction(goalId), "Goal resumed — heartbeat restarted.")}
        >
          <Play className="size-3.5" />
          <span className="hidden sm:inline">Resume</span>
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        aria-label="Close goal"
        disabled={pending}
        onClick={() => setKillOpen(true)}
        className="text-[hsl(0_72%_51%)]"
      >
        <Square className="size-3.5" />
        <span className="hidden sm:inline">Close goal</span>
      </Button>

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

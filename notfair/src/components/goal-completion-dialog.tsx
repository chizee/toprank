"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Sparkles,
  Trophy,
} from "lucide-react";
import {
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveCompletedGoalAction,
  continueCompletedGoalAction,
} from "@/server/actions/goals";
import { formatMetric } from "@/lib/format-metric";

const CONFETTI = Array.from({ length: 20 }, (_, index) => ({
  angle: index * 18 + (index % 3) * 4,
  delay: (index % 5) * 32,
  distance: 90 + (index % 4) * 15,
  color: ["#4CAF6E", "#F1B94A", "#8B7CF6", "#54A7E8", "#F26D85"][
    index % 5
  ],
}));

export type GoalCompletionDialogProps = {
  goalId: string;
  label: string;
  metricName: string | null;
  currentValue: number | null;
  targetValue: number | null;
  metricDirection: "increase" | "decrease" | null;
  completionReason: string | null;
  completedAt: string;
  goalHref?: string;
  trigger: ReactNode;
};

/**
 * The explicit handoff between "the agent hit the number" and "the user
 * decides what happens next." Closing the dialog leaves the achievement in
 * the sidebar, so celebration can never accidentally become dismissal.
 */
export function GoalCompletionDialog({
  goalId,
  label,
  metricName,
  currentValue,
  targetValue,
  metricDirection,
  completionReason,
  completedAt,
  goalHref,
  trigger,
}: GoalCompletionDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"celebrate" | "continue">("celebrate");
  const [target, setTarget] = useState("");
  const [nextLabel, setNextLabel] = useState(label);
  const [labelEdited, setLabelEdited] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [pending, startTransition] = useTransition();
  const completedLabel = useMemo(
    () =>
      new Date(completedAt).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    [completedAt],
  );

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setStep("celebrate");
      setTarget("");
      setNextLabel(label);
      setLabelEdited(false);
      setDeadline("");
    }
  }

  function archive() {
    startTransition(async () => {
      const result = await archiveCompletedGoalAction(goalId);
      if (!result.ok) {
        toast.error(result.error ?? "Could not archive this goal.");
        return;
      }
      changeOpen(false);
      toast.success("Achievement archived — its full story is saved in All goals.");
      router.refresh();
    });
  }

  function continueGoal() {
    const targetValue = Number(target);
    if (!target.trim() || !Number.isFinite(targetValue)) {
      toast.error("Enter a valid next target.");
      return;
    }
    startTransition(async () => {
      const result = await continueCompletedGoalAction(goalId, {
        target_value: targetValue,
        deadline: deadline || null,
        label: nextLabel.trim() || null,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Could not start the next milestone.");
        return;
      }
      changeOpen(false);
      toast.success("Next milestone started — your goal is running again.");
      router.refresh();
    });
  }

  const directionWord =
    metricDirection === "increase"
      ? "above"
      : metricDirection === "decrease"
        ? "below"
        : "beyond";

  function updateTarget(value: string) {
    setTarget(value);
    if (labelEdited) return;
    const numeric = Number(value);
    if (!value.trim() || !Number.isFinite(numeric)) {
      setNextLabel(label);
      return;
    }
    const nextValue = formatMetric(numeric);
    const oldValue = formatMetric(targetValue);
    if (targetValue !== null && label.includes(oldValue)) {
      setNextLabel(label.replace(oldValue, nextValue));
      return;
    }
    const rawOldValue = targetValue === null ? "" : String(targetValue);
    if (rawOldValue && label.includes(rawOldValue)) {
      setNextLabel(label.replace(rawOldValue, nextValue));
      return;
    }
    setNextLabel(`${metricName ?? label} → ${nextValue}`);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-[540px]"
      >
        {step === "celebrate" ? (
          <>
            <div className="ns-celebration-stage">
              <div className="ns-celebration-halo" aria-hidden />
              <div className="ns-celebration-confetti" aria-hidden>
                {CONFETTI.map((piece, index) => (
                  <span
                    key={index}
                    style={
                      {
                        "--angle": `${piece.angle}deg`,
                        "--delay": `${piece.delay}ms`,
                        "--distance": `-${piece.distance}px`,
                        "--piece-color": piece.color,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
              <div className="ns-celebration-medal" aria-hidden>
                <Trophy />
                <span><Check /></span>
              </div>
              <div className="relative z-10 px-6 pt-2 text-center">
                <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-[hsl(var(--notfair-accent))] uppercase">
                  <Sparkles className="size-3.5" />
                  Goal completed
                </div>
                <DialogHeader className="items-center text-center sm:text-center">
                  <DialogTitle className="text-[28px] leading-[1.08] tracking-[-0.035em]">
                    You did it.
                  </DialogTitle>
                  <DialogDescription
                    className="max-w-[42ch] text-[14px] leading-relaxed"
                  >
                    <span className="font-medium text-[hsl(var(--notfair-ink-2))]">
                      {label}
                    </span>{" "}
                    crossed the finish line. Every check and smart adjustment
                    added up to this result.
                  </DialogDescription>
                </DialogHeader>
              </div>
            </div>

            <div className="px-6 pt-1 pb-6">
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-[hsl(var(--notfair-surface-2)/0.62)] p-1.5">
                <div className="rounded-[9px] bg-[hsl(var(--card))] px-4 py-3 shadow-[var(--notfair-shadow-sm)]">
                  <div className="text-[10px] font-medium tracking-[0.08em] text-[hsl(var(--notfair-ink-4))] uppercase">
                    Result
                  </div>
                  <div className="mt-1 text-[22px] leading-none font-semibold tabular-nums tracking-[-0.03em]">
                    {formatMetric(currentValue)}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-[hsl(var(--notfair-ink-4))]">
                    {metricName ?? "Measured goal"}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[10px] font-medium tracking-[0.08em] text-[hsl(var(--notfair-ink-4))] uppercase">
                    Target
                  </div>
                  <div className="mt-1 text-[22px] leading-none font-semibold tabular-nums tracking-[-0.03em] text-[hsl(var(--notfair-accent))]">
                    {formatMetric(targetValue)}
                  </div>
                  <div className="mt-1 text-[11px] text-[hsl(var(--notfair-ink-4))]">
                    Completed {completedLabel}
                  </div>
                </div>
              </div>

              {completionReason && (
                <p className="mt-3 mb-0 line-clamp-2 text-center text-[12px] leading-relaxed text-[hsl(var(--notfair-ink-4))]">
                  {completionReason}
                </p>
              )}

              <div className="mt-5">
                <p className="mb-2 text-center text-[12px] font-medium text-[hsl(var(--notfair-ink-3))]">
                  Ready to choose what happens next?
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    onClick={() => setStep("continue")}
                    disabled={pending}
                  >
                    Set a new target
                    <ArrowRight />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={archive}
                    disabled={pending}
                  >
                    <Archive />
                    Archive goal
                  </Button>
                </div>
                {goalHref && (
                  <Button
                    asChild
                    variant="ghost"
                    className="mt-1 w-full text-[12px] text-[hsl(var(--notfair-ink-4))]"
                  >
                    <Link href={goalHref} onClick={() => setOpen(false)}>
                      View the full story
                      <ExternalLink />
                    </Link>
                  </Button>
                )}
                <p className="mt-2 mb-0 text-center text-[11px] leading-relaxed text-[hsl(var(--notfair-ink-4))]">
                  Not ready? Close this window. The Completed badge will stay
                  in your sidebar until you decide.
                </p>
              </div>
            </div>
          </>
        ) : (
          <form
            className="p-6"
            onSubmit={(event) => {
              event.preventDefault();
              continueGoal();
            }}
          >
            <DialogHeader>
              <button
                type="button"
                className="mb-3 flex w-fit items-center gap-1 rounded-md text-[12px] text-[hsl(var(--notfair-ink-4))] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setStep("celebrate")}
              >
                <ArrowLeft className="size-3.5" />
                Back to your result
              </button>
              <DialogTitle className="text-[22px] tracking-[-0.025em]">
                What’s the next milestone?
              </DialogTitle>
              <DialogDescription
                className="leading-relaxed"
              >
                Keep the same metric, history, and agent. Set a target{" "}
                {directionWord} your completed result of{" "}
                <span className="font-medium tabular-nums text-[hsl(var(--notfair-ink-2))]">
                  {formatMetric(currentValue)}
                </span>
                , and the goal will start running again.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor={`next-target-${goalId}`}>
                  New target
                </Label>
                <Input
                  id={`next-target-${goalId}`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={target}
                  onChange={(event) => updateTarget(event.target.value)}
                  placeholder={`${directionWord[0].toUpperCase()}${directionWord.slice(1)} ${formatMetric(currentValue)}`}
                  autoFocus
                  required
                />
                <p className="m-0 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                  {metricName ?? "The same verified metric"} will stay as the
                  source of truth.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`next-label-${goalId}`}>
                  Goal name
                </Label>
                <Input
                  id={`next-label-${goalId}`}
                  value={nextLabel}
                  onChange={(event) => {
                    setNextLabel(event.target.value);
                    setLabelEdited(true);
                  }}
                  maxLength={120}
                  required
                />
                <p className="m-0 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                  This is how the new milestone appears in your sidebar.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`next-deadline-${goalId}`}>
                  Deadline <span className="font-normal text-[hsl(var(--notfair-ink-4))]">(optional)</span>
                </Label>
                <Input
                  id={`next-deadline-${goalId}`}
                  type="date"
                  min={new Date().toISOString().slice(0, 10)}
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </div>
            </div>

            <DialogFooter className="mt-7">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("celebrate")}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending || !target.trim() || !nextLabel.trim()}
              >
                {pending ? "Starting…" : "Start next milestone"}
                <ArrowRight />
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

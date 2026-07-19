"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { markUserActionHandledAction } from "@/server/actions/goals";
import { timeAgo } from "@/lib/time-ago";

export type NeedsYouItem = {
  action_id: string;
  /** Full escalation text, "USER ACTION REQUIRED" prefix already stripped. */
  ask: string;
  tick_number: number | null;
  raised_at: string;
};

/**
 * The escalation surface: open asks only the USER can resolve, one amber
 * button in the goal header. Everything else in the loop is the agent's
 * job — this dialog is the one place that is explicitly yours. The
 * trigger renders nothing when there is nothing to do; when it shows,
 * the agent repeats the same asks in every check summary until telemetry
 * proves the fix (or you mark one handled here, which the agent later
 * verifies — and re-escalates if it is still broken).
 */
export function GoalNeedsYouDialog({ items }: { items: NeedsYouItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (items.length === 0) return null;

  function markHandled(item: NeedsYouItem) {
    startTransition(async () => {
      const r = await markUserActionHandledAction(item.action_id);
      if (!r.ok) {
        toast.error(r.error ?? "Could not mark it handled.");
        return;
      }
      toast.success("Marked handled — the agent verifies it on a later check.");
      if (items.length === 1) setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="ns-chip !bg-[hsl(var(--notfair-warn)/0.15)] font-medium !text-[hsl(var(--notfair-warn))] hover:!bg-[hsl(var(--notfair-warn)/0.25)]"
          title="Actions only you can take — the agent is blocked on these"
        >
          <TriangleAlert className="size-3.5" aria-hidden />
          Needs you
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-[hsl(var(--notfair-warn))] px-1 text-[10.5px] font-semibold tabular-nums text-[hsl(var(--notfair-surface-1))]">
            {items.length}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[75vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <TriangleAlert
              className="size-4 text-[hsl(var(--notfair-warn))]"
              aria-hidden
            />
            Needs you
          </DialogTitle>
          <DialogDescription>
            The agent hit things only you can fix — credentials, app
            permissions, account settings. It repeats each ask in every
            check until telemetry proves the fix. Marking one handled
            closes the ask; it re-escalates if still broken.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <li
              key={item.action_id}
              className="rounded-xl bg-[hsl(var(--notfair-warn)/0.09)] p-3"
            >
              <p className="m-0 text-[12.5px] leading-relaxed">{item.ask}</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-[hsl(var(--notfair-ink-4))]">
                  raised {timeAgo(item.raised_at)}
                  {item.tick_number !== null && ` · check #${item.tick_number}`}
                </span>
                <button
                  type="button"
                  className="ns-btn ns-btn-ghost shrink-0 !px-2 !py-0.5 text-[11.5px]"
                  disabled={pending}
                  onClick={() => markHandled(item)}
                >
                  <Check className="size-3" />
                  Mark handled
                </button>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

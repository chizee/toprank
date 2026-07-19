"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Check, TriangleAlert } from "lucide-react";
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
 * The escalation surface: open asks only the USER can resolve, pinned at
 * the top of the goal rail. Everything else in the loop is the agent's
 * job — this card is the one place that is explicitly yours. It renders
 * nothing when there is nothing to do; when it shows, the agent repeats
 * the same asks in every check summary until telemetry proves the fix
 * (or you mark one handled here, which the agent later verifies).
 */
export function GoalNeedsYou({ items }: { items: NeedsYouItem[] }) {
  const router = useRouter();
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
      router.refresh();
    });
  }

  return (
    <section
      aria-label={`Needs you: ${items.length} action${items.length === 1 ? "" : "s"}`}
      className="ns-card bg-[hsl(var(--notfair-warn)/0.09)] p-3.5"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <TriangleAlert aria-hidden className="size-3.5 text-[hsl(var(--notfair-warn))]" />
        <h2 className="m-0 text-[11px] font-semibold tracking-wide text-[hsl(var(--notfair-warn))] uppercase">
          Needs you
        </h2>
        <span className="text-[11px] tabular-nums text-[hsl(var(--notfair-warn))]">
          {items.length}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => (
          <li key={item.action_id}>
            <p className="m-0 text-[12.5px] leading-relaxed">{item.ask}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
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
      <p className="mt-2.5 mb-0 text-[11px] leading-relaxed text-[hsl(var(--notfair-ink-4))]">
        The agent repeats these in every check until telemetry proves the fix.
        Marking one handled closes the ask — it re-escalates if still broken.
      </p>
    </section>
  );
}

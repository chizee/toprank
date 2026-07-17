"use client";

import Link from "next/link";
import { useState } from "react";
import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/format-metric";
import { timeAgo } from "@/lib/time-ago";

// Local copy of the status union — this component is client-side and takes
// plain JSON props; importing from the server db module would be noise.
type GoalStatus =
  | "intake"
  | "proposed"
  | "active"
  | "paused"
  | "achieved"
  | "failed"
  | "killed";

export type BoardGoal = {
  id: string;
  href: string;
  label: string;
  statement: string;
  status: GoalStatus;
  status_reason: string | null;
  metric_name: string | null;
  baseline_value: number | null;
  current_value: number | null;
  target_value: number | null;
  metric_direction: "increase" | "decrease" | null;
  mode: "achieve" | "maintain";
  tick_count: number;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

type GroupKey = "setup" | "running" | "paused" | "achieved" | "failed" | "closed";

/**
 * Board columns. Intake and proposed share a column — both are "the goal
 * isn't running yet"; the card chip tells them apart (and flags the one
 * that's waiting on the user's START). The three terminal states each get
 * their own column so an achieved goal reads as a win, not just "gone".
 */
const GROUPS: Array<{
  key: GroupKey;
  title: string;
  statuses: GoalStatus[];
  dot: string;
}> = [
  { key: "setup", title: "Setting up", statuses: ["intake", "proposed"], dot: "ns-dot-warn" },
  { key: "running", title: "Running", statuses: ["active"], dot: "ns-dot-live" },
  { key: "paused", title: "Paused", statuses: ["paused"], dot: "ns-dot-mute" },
  { key: "achieved", title: "Achieved", statuses: ["achieved"], dot: "ns-dot-on" },
  { key: "failed", title: "Failed", statuses: ["failed"], dot: "ns-dot-err" },
  { key: "closed", title: "Closed", statuses: ["killed"], dot: "ns-dot-mute" },
];

const TERMINAL: GoalStatus[] = ["achieved", "failed", "killed"];

/**
 * Jira-style board of every goal in the project, one column per lifecycle
 * group, with toggleable status filters. Read-only: cards link to the goal
 * screen where the real controls live.
 */
export function GoalsBoard({ goals }: { goals: BoardGoal[] }) {
  const [visible, setVisible] = useState<Set<GroupKey>>(
    () => new Set(GROUPS.map((g) => g.key)),
  );

  function toggle(key: GroupKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const columns = GROUPS.map((group) => {
    const items = goals
      .filter((g) => group.statuses.includes(g.status))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        // Closed columns: most recently closed first. Live columns: newest first.
        const key = TERMINAL.includes(a.status) ? "updated_at" : "created_at";
        return b[key].localeCompare(a[key]);
      });
    return { ...group, items };
  });

  const shown = columns.filter((c) => visible.has(c.key));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter goals by status">
        {columns.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => toggle(c.key)}
            aria-pressed={visible.has(c.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors",
              visible.has(c.key)
                ? "bg-[hsl(var(--notfair-accent-soft))] text-[hsl(var(--notfair-accent))] shadow-[var(--notfair-shadow-sm)]"
                : "bg-[hsl(var(--notfair-surface-2)/0.6)] text-[hsl(var(--notfair-ink-3))] hover:bg-[hsl(var(--notfair-surface-2))]",
            )}
          >
            <span className={cn("ns-dot", c.dot)} aria-hidden />
            {c.title}
            <span className="tabular-nums opacity-70">{c.items.length}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="m-0 py-10 text-center text-[13px] text-[hsl(var(--notfair-ink-4))]">
          Every status is filtered out — turn one back on above.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-4">
          {shown.map((c) => (
            <section
              key={c.key}
              aria-label={c.title}
              className="flex max-h-full w-[280px] shrink-0 flex-col rounded-xl bg-[hsl(var(--notfair-surface-2)/0.5)]"
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className={cn("ns-dot", c.dot)} aria-hidden />
                <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--notfair-ink-3))]">
                  {c.title}
                </h2>
                <span className="text-[11px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
                  {c.items.length}
                </span>
              </header>
              <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {c.items.length === 0 ? (
                  <p className="m-0 px-1.5 py-6 text-center text-[12px] text-[hsl(var(--notfair-ink-4))]">
                    No goals here
                  </p>
                ) : (
                  c.items.map((g) => <GoalCard key={g.id} goal={g} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** Direction-agnostic progress toward target, 0..1, or null when unknowable. */
function progressFraction(g: BoardGoal): number | null {
  if (
    g.baseline_value === null ||
    g.current_value === null ||
    g.target_value === null ||
    g.target_value === g.baseline_value
  ) {
    return null;
  }
  const f = (g.current_value - g.baseline_value) / (g.target_value - g.baseline_value);
  return Math.min(1, Math.max(0, f));
}

function GoalCard({ goal }: { goal: BoardGoal }) {
  const closed = TERMINAL.includes(goal.status);
  const progress =
    goal.status === "active" || goal.status === "paused" ? progressFraction(goal) : null;

  return (
    <Link
      href={goal.href}
      className="ns-card block p-3 no-underline transition-shadow hover:shadow-[var(--notfair-shadow)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[13px] leading-snug font-semibold text-foreground">
          {goal.label}
        </span>
        {goal.pinned && (
          <Pin
            aria-label="Pinned"
            className="mt-0.5 size-3 shrink-0 text-[hsl(var(--notfair-ink-4))]"
          />
        )}
      </div>

      {goal.status === "proposed" && (
        <span className="ns-tag-accent mt-1.5 inline-block">ready to start</span>
      )}
      {goal.status === "intake" && (
        <span className="ns-tag mt-1.5 inline-block">defining metric</span>
      )}

      <p className="m-0 mt-1.5 line-clamp-2 text-[12px] leading-snug text-[hsl(var(--notfair-ink-3))]">
        {goal.statement}
      </p>

      {goal.metric_name && goal.target_value !== null && (
        <p className="m-0 mt-2 text-[11.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
          <span className="text-[hsl(var(--notfair-ink-3))]">{goal.metric_name}</span>{" "}
          {formatMetric(goal.current_value)} / {formatMetric(goal.target_value)}
          {goal.mode === "maintain" ? " (hold)" : ""}
        </p>
      )}

      {progress !== null && (
        <div
          className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-[hsl(var(--notfair-ink-4)/0.12)]"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-[hsl(var(--notfair-accent))]"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {closed && goal.status_reason && (
        <p className="m-0 mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-[hsl(var(--notfair-ink-4))]">
          {goal.status_reason}
        </p>
      )}

      <p className="m-0 mt-2 text-[11px] text-[hsl(var(--notfair-ink-4))]">
        {goal.tick_count} check{goal.tick_count === 1 ? "" : "s"} ·{" "}
        {closed ? `closed ${timeAgo(goal.updated_at)}` : `updated ${timeAgo(goal.updated_at)}`}
      </p>
    </Link>
  );
}
